/**
 * Assistant/RCA thread cross-replica bridge (Redis): with 3 replicas + nginx round-robin, a thread's session
 * lives in one replica's process memory; the other replicas can't see its running state, receive no events,
 * and cancel fires into the void. This module moves three things onto Redis:
 * - Event mirroring: session.ts's fanOut/emitThreadEvent PUBLISHes along the way (envelope {o,e}); the SSE route
 *   receives "other-replica" events via subscribeThreadMirror and passes them through into the same response
 *   (same-origin loops on this replica are skipped — local listeners already delivered them; passing them through
 *   again would show the frontend's seq deduplicator a double copy).
 * - cancel command: PSUBSCRIBE itest:thread-cmd:* → abort if this replica holds that thread's record. The handler is
 *   injected by session.ts (avoiding a threadBus ↔ session module cycle); cancelThread takes the local fast path and always PUBLISHes.
 * - Running-state probing: the itest:thread-run lock key is maintained by session.ts via redisLock (5s heartbeat renewal
 *   while runs>0); threadRunRemote probes it with EXISTS so threadStatusAsync can mark threads running on other replicas as running.
 * Without REDIS_URL (local dev / vitest) everything is a no-op and behavior is identical to the single-process version.
 */
import IORedis, { type Redis } from 'ioredis';
import { ORIGIN_ID } from '../../lib/redisLock.js';

export const THREAD_EV_PREFIX = 'itest:thread-ev:';
export const THREAD_CMD_PREFIX = 'itest:thread-cmd:';
const THREAD_CMD_PATTERN = `${THREAD_CMD_PREFIX}*`;
/** Run-lock key prefix (value = the holding replica's ORIGIN_ID; key TTL/heartbeat live in session.ts). */
export const THREAD_RUN_PREFIX = 'itest:thread-run:';

let _pub: Redis | null = null;
let _sub: Redis | null = null;
let _cancelHandler: ((threadId: string) => void) | null = null;
let _cmdWatchStarted = false;

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
      if (!chan.startsWith(THREAD_EV_PREFIX)) return;
      dispatchEvent(chan.slice(THREAD_EV_PREFIX.length), msg);
    });
    _sub.on('pmessage', (pattern: string, chan: string, msg: string) => {
      if (pattern !== THREAD_CMD_PATTERN) return;
      dispatchCommand(chan.slice(THREAD_CMD_PREFIX.length), msg);
    });
  }
  return _sub;
}

// ── Event mirroring ─────────────────────────────────────────────────────────────────

/** threadId → the set of SSE forwarding callbacks on this replica (share one SUBSCRIBE connection; unsubscribe only when the last one leaves). */
const _evHandlers = new Map<string, Set<(e: unknown) => void>>();
const _evSubscribed = new Set<string>();

/** Source side: thread event publishing (fire-and-forget; stamped already carries threadId+seq, the frontend dedups by seq). */
export function publishThreadEvent(threadId: string, stamped: Record<string, unknown>): void {
  void getPub()
    ?.publish(`${THREAD_EV_PREFIX}${threadId}`, JSON.stringify({ o: ORIGIN_ID, e: stamped }))
    .catch(() => undefined);
}

function dispatchEvent(threadId: string, msg: string): void {
  const set = _evHandlers.get(threadId);
  if (!set || set.size === 0) return;
  let env: { o?: string; e?: unknown };
  try {
    env = JSON.parse(msg) as { o?: string; e?: unknown };
  } catch {
    return;
  }
  if (env.o === ORIGIN_ID) return; // this replica's own loop: local listeners already delivered
  for (const fn of set) {
    try { fn(env.e); } catch { /* a single subscriber's failure must not drag down the dispatch */ }
  }
}

/** SSE side: subscribe to other-replica mirror events (forwarding cross-origin ones to fn; this replica's own loops are skipped). Returns the unsubscribe function (idempotent). */
export function subscribeThreadMirror(threadId: string, fn: (e: unknown) => void): () => void {
  let set = _evHandlers.get(threadId);
  const first = !set || set.size === 0;
  if (!set) {
    set = new Set();
    _evHandlers.set(threadId, set);
  }
  set.add(fn);
  if (first) {
    const sub = getSub();
    if (sub) {
      _evSubscribed.add(threadId);
      void sub.subscribe(`${THREAD_EV_PREFIX}${threadId}`).catch(() => {
        _evSubscribed.delete(threadId);
      });
    }
  }
  return () => {
    const cur = _evHandlers.get(threadId);
    if (!cur || !cur.delete(fn)) return;
    if (cur.size === 0) {
      _evHandlers.delete(threadId);
      const sub = getSub();
      if (sub && _evSubscribed.delete(threadId)) {
        void sub.unsubscribe(`${THREAD_EV_PREFIX}${threadId}`).catch(() => undefined);
      }
    }
  };
}

// ── Thread event seq (globally monotonic) ──────────────────────────────────────────────────
// seq used to be a per-replica in-memory counter: three replicas kept three ledgers, replica restarts / cold builds
// zeroed them, and the baseline carried by the SSE snapshot envelope went wrong accordingly — react-pi treats
// "a snapshot with a lower seq" as a sequence reset (lastSeq snapped back to ~0), then subsequent mirror
// message_start events append unconditionally, and the user message exists once in the snapshot plus once in an
// event = a doubled bubble on the frontend. After seq moved up to
// Redis (one INCR per event, allocated inside the serial pump; see session.ts), the baseline is globally monotonic;
// snapshots/GET bodies carry the true high-water mark, and react-pi's built-in stale-event gate / snapshot-reset
// detection / overtaken protections all take effect.

export const THREAD_SEQ_PREFIX = 'itest:thread-seq:';
/** In-process fallback counter when Redis fails / is absent (cross-replica consistency is lost; single-process semantics unchanged). */
const localSeqFallback = new Map<string, number>();

/** Allocate the next global event seq. On Redis failure it degrades to local counting: high seqs already emitted
 *  will make other replicas' events temporarily held back by the frontend's stale-event gate until the next snapshot
 *  rebuilds the baseline — a self-healing degradation. */
export async function allocateThreadSeq(threadId: string): Promise<number> {
  const r = getPub();
  if (r) {
    try {
      return await r.incr(`${THREAD_SEQ_PREFIX}${threadId}`);
    } catch { /* fall to the local fallback */ }
  }
  const next = (localSeqFallback.get(threadId) ?? 0) + 1;
  localSeqFallback.set(threadId, next);
  return next;
}

/** Current seq high-water mark (cold-build baseline). Missing key / no Redis → 0. */
export async function currentThreadSeq(threadId: string): Promise<number> {
  const r = getPub();
  if (r) {
    try {
      return Number(await r.get(`${THREAD_SEQ_PREFIX}${threadId}`)) || 0;
    } catch { /* fall to the local fallback */ }
  }
  return localSeqFallback.get(threadId) ?? 0;
}

/** Clear the seq key when a thread is deleted (idempotent). Ids are never reused — hygiene only; process restarts / Redis restarts must not clear it —
 *  global monotonicity is precisely the state that must survive restarts. */
export function deleteThreadSeq(threadId: string): void {
  localSeqFallback.delete(threadId);
  void getPub()?.del(`${THREAD_SEQ_PREFIX}${threadId}`).catch(() => undefined);
}

// ── cancel command ──────────────────────────────────────────────────────────────

/** Source side: broadcast the cancel command (value = the originating replica's ORIGIN_ID, so each replica can filter out its own loop). */
export function publishThreadCancel(threadId: string): void {
  void getPub()?.publish(`${THREAD_CMD_PREFIX}${threadId}`, ORIGIN_ID).catch(() => undefined);
}

function dispatchCommand(threadId: string, msg: string): void {
  if (msg === ORIGIN_ID) return; // this replica's cancelThread already aborted via the local fast path
  _cancelHandler?.(threadId);
}

/** Register the local abort handler and (once) PSUBSCRIBE the command channel; without Redis, register only and don't subscribe.
 *  Called at session.ts module load; repeated calls only update the handler, never re-subscribe. */
export function startThreadCommandWatch(onCancel: (threadId: string) => void): void {
  _cancelHandler = onCancel;
  if (_cmdWatchStarted) return;
  const sub = getSub();
  if (!sub) return;
  _cmdWatchStarted = true;
  void sub.psubscribe(THREAD_CMD_PATTERN).catch(() => {
    _cmdWatchStarted = false;
  });
}

// ── Running-state probing ───────────────────────────────────────────────────────────────

/** Whether another replica currently holds this thread's run lock. No Redis / error → false (degrades to the local view). */
export async function threadRunRemote(threadId: string): Promise<boolean> {
  const r = getPub();
  if (!r) return false;
  try {
    return (await r.exists(`${THREAD_RUN_PREFIX}${threadId}`)) > 0;
  } catch {
    return false;
  }
}
