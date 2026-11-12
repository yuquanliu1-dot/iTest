/**
 * Human-review pending registry (confirm gate).
 * A sensitive tool action calls requestConfirmation before executing: broadcast confirm_request to
 * thread SSE subscribers, then await the user's decision on the confirmation card
 * (POST /api/assistant/threads/:id/confirm).
 * To the LLM it is just a "slower-than-usual normal tool call"; the pi session protocol is untouched.
 * Pending state lives only in memory (bounded by CONFIRM_TIMEOUT_MS): an API restart loses one
 * pending turn = that turn errors and the user repeats; no table is created.
 * Cross-replica: the tool lives on the running replica, but the user's confirm POST may land on
 * another replica — while pending, the event body is SET into Redis (claim key) and the answer
 * channel is subscribed; another replica's resolveConfirmation does a GETDEL atomic claim +
 * PUBLISHes the answer back to the pending replica. Without REDIS_URL (local dev / vitest) no gate
 * is built and behavior matches the single-process version byte for byte.
 */
import { randomUUID } from 'node:crypto';
import IORedis, { type Redis } from 'ioredis';

export type ConfirmRisk = 'update' | 'delete' | 'secret';

export interface ConfirmRequestInput {
  threadId: string;
  toolName: string;
  action: string;
  /** Confirmation card headline, e.g. "delete case 「登录-正常」"; secret-type must not contain plaintext values. */
  summary: string;
  /** Human-readable diff text (update type); absent by default. */
  diff?: string;
  risk: ConfirmRisk;
}

type Resolver = (approved: boolean) => void;

interface PendingEntry {
  resolve: Resolver;
  timer: NodeJS.Timeout;
  /** confirm_request event body snapshot: on SSE reconnect only still-pending cards are replayed
   *  (read by session.ts's subscribeThread); processed/timed-out cards vanish from the replay source
   *  automatically with the pending deletion, never resurrecting. */
  payload: Record<string, unknown>;
}

export const CONFIRM_TIMEOUT_MS = 5 * 60_000;

const pending = new Map<string, PendingEntry>();

// ── Cross-replica gate (Redis) ─────────────────────────────────────────────
// Claim key itest:confirm:<confirmId> = event body JSON (PX = pending timeout, self-clears);
// Answer channel itest:confirm-res:<confirmId> carries messages '1'/'0'. GETDEL guarantees exactly one replica claims.

const KEY_PREFIX = 'itest:confirm:';
const RES_PREFIX = 'itest:confirm-res:';

let _pub: Redis | null = null;
let _sub: Redis | null = null;
/** confirmId → local finalization (equivalent to entry.resolve + cleanup): used for answer-channel message dispatch. */
const _waiters = new Map<string, Resolver>();
const _subscribed = new Set<string>();

function getPub(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  if (!_pub) {
    _pub = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
    _pub.on('error', () => undefined);
  }
  return _pub;
}

function getSub(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  if (!_sub) {
    _sub = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
    _sub.on('error', () => undefined);
    _sub.on('message', (chan: string, msg: string) => {
      if (!chan.startsWith(RES_PREFIX)) return;
      const confirmId = chan.slice(RES_PREFIX.length);
      const waiter = _waiters.get(confirmId);
      if (!waiter) return;
      _waiters.delete(confirmId);
      waiter(msg === '1');
    });
  }
  return _sub;
}

/** Opens the cross-replica gate while pending: writes the claim key + subscribes to the answer channel.
 *  A subscribe failure only loses cross-replica confirmation (this replica's path is unaffected); a claim-key
 *  write failure means the other replica's GETDEL misses → confirm 404, and the pending replica's timeout is the fallback. */
function openRedisGate(confirmId: string, payload: Record<string, unknown>, settle: Resolver): void {
  const pub = getPub();
  const sub = getSub();
  if (!pub || !sub) return;
  _waiters.set(confirmId, settle);
  const chan = `${RES_PREFIX}${confirmId}`;
  _subscribed.add(confirmId);
  void sub.subscribe(chan).catch(() => undefined);
  void pub.set(`${KEY_PREFIX}${confirmId}`, JSON.stringify(payload), 'PX', CONFIRM_TIMEOUT_MS).catch(() => undefined);
}

/** Closes the cross-replica gate: unsubscribe + delete claim key. All three paths (local resolve/
 *  timeout/answer arrival) go through it — deleting the key after local resolve is especially
 *  necessary: a late duplicate click must not be able to claim an already-closed gate. */
function closeRedisGate(confirmId: string): void {
  _waiters.delete(confirmId);
  if (_subscribed.delete(confirmId)) {
    void _sub?.unsubscribe(`${RES_PREFIX}${confirmId}`).catch(() => undefined);
  }
  void _pub?.del(`${KEY_PREFIX}${confirmId}`).catch(() => undefined);
}

/**
 * Initiates a confirmation and pends. emit fans the confirm_request event out to the thread SSE
 * (session.ts's emitThreadEvent); the event body automatically carries confirmId. emit must not
 * throw (emitThreadEvent silently drops when there are no subscribers — naturally satisfied);
 * throwing would leave a dangling pending entry.
 * Timeout/cancel always resolve(false); the caller returns it to the LLM as
 * { ok:false, error:'用户取消了该操作' }.
 */
export function requestConfirmation(req: ConfirmRequestInput, emit: (e: Record<string, unknown>) => void): Promise<boolean> {
  const confirmId = randomUUID();
  // Event body constructed once: emit (live) and pending.payload (reconnect replay) share the same object, keeping both paths consistent
  const payload = { type: 'confirm_request', confirmId, ...req } as Record<string, unknown>;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(confirmId);
      closeRedisGate(confirmId);
      resolve(false);
    }, CONFIRM_TIMEOUT_MS);
    const resolveLocal = (approved: boolean): void => {
      pending.delete(confirmId);
      clearTimeout(timer);
      closeRedisGate(confirmId);
      resolve(approved);
    };
    pending.set(confirmId, { resolve: resolveLocal, timer, payload });
    emit(payload);
    openRedisGate(confirmId, payload, resolveLocal);
  });
}

/** Settles the confirmation result; unknown confirmId (timed out/already handled/forged) returns false.
 *  When nothing is pending locally, probe the cross-replica gate: GETDEL atomic claim → on hit PUBLISH
 *  the answer back to the pending replica (duplicate clicks/concurrent claims: only one takes effect). */
export async function resolveConfirmation(confirmId: string, approved: boolean): Promise<boolean> {
  const entry = pending.get(confirmId);
  if (entry) {
    pending.delete(confirmId);
    entry.resolve(approved);
    return true;
  }
  const pub = getPub();
  if (!pub) return false;
  try {
    const raw = await pub.getdel(`${KEY_PREFIX}${confirmId}`);
    if (!raw) return false;
    await pub.publish(`${RES_PREFIX}${confirmId}`, approved ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}

/** List of pending confirmation-card event bodies (for SSE reconnect replay); only still-pending
 *  cards, timed-out/processed ones drop out of the list automatically.
 *  Known gap (accepted): reads only this replica's pendings — a cross-replica pending (RCA thread)
 *  loses the card at the SSE-reconnect instant; live answers/event mirrors still deliver later state. */
export function pendingConfirmPayloads(): Array<Record<string, unknown>> {
  return [...pending.values()].map((e) => e.payload);
}

export function pendingCountForTesting(): number {
  return pending.size;
}
