/**
 * Version-space AI assistant thread supervisor (pi/space).
 * Bound to versionId, one session per thread, one version can have many threads.
 * The context summary is injected via the system prompt (at session creation).
 */
import { and, eq } from 'drizzle-orm';
import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from '../../db/client.js';
import { aiThreads, projectVersions, users } from '../../db/schema.js';
import { aiLangFrom, type AiLang } from '../../agent/langDirective.js';
import { logger } from '../../logger.js';
import { isEffectiveManagerOf } from '../../services/auth.service.js';
import { buildSpaceTools } from './tools/index.js';
import { buildSkillsSectionContent } from './tools/readSkill.js';
import { buildSpaceSummary } from './summary.js';
import { type AssistantGuideRow, buildGuidesSection, loadActiveGuides } from './guides.js';
import { buildMemoriesSection, loadActiveMemories, resolveProductLineId } from './memories.js';
import { buildTrajectoriesSection, loadActiveTrajectories } from './trajectories.js';
import { loadEnabledSkillDirs } from './skillsStore.js';
import {
  STYLE_EN_DEFAULT, STYLE_ZH_DEFAULT, WORKSPACE_DEFAULT,
  STYLE_EN_KEY, STYLE_ZH_KEY, WORKSPACE_KEY,
  applyToolTextOverrides, loadPromptModuleOverridesSafe, textOverrideOf,
} from './promptModules.js';
import { buildMcpExtensionFactory, getMcpServersForThread } from './mcp.js';
import { readLlmConfig, synthesizeModel, ENV_BY_PROVIDER } from '../modelBridge.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { defineTool, sessionEntryToContextMessages, type CompactionEntry, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { checkoutRepoForVersion, LockTimeoutError, RepoUnavailableError, DATA_DIR, REPOS_ROOT, versionWorkspaceDir } from '../repo.js';
import { emptyRepoState, type RepoState } from './tools/context.js';
import { pendingConfirmPayloads } from './confirm.js';
import { tryAcquireLock, type RedisLock } from '../../lib/redisLock.js';
import {
  allocateThreadSeq, currentThreadSeq, deleteThreadSeq,
  publishThreadCancel, publishThreadEvent, startThreadCommandWatch, threadRunRemote, THREAD_RUN_PREFIX,
} from './threadBus.js';

/** pi session JSONL persistence directory. Lives on the .data shared volume (shared by prod228's three replicas); must not use pi's default
 *  ~/.pi/agent/sessions (local disk inside the container, invisible across replicas). */
export const SESSIONS_ROOT = path.join(DATA_DIR, 'pi-sessions');

/** Image attachment (pi-ai's ImageContent shape): bare base64 string, without the data: prefix. */
export interface SpacePromptImage {
  data: string;
  mimeType: string;
}

export interface SpaceSessionLike {
  subscribe(fn: (e: unknown) => void): () => void;
  /** For streamingBehavior see sendSpaceUserMessage: omitting it while running gets rejected by Pi.
   *  For images see sendSpaceUserMessage: same shape as pi PromptOptions.images. */
  prompt(text: string, options?: { streamingBehavior?: 'steer' | 'followUp'; images?: SpacePromptImage[] }): Promise<void>;
  abort(): void;
  // pi v0.99.2's AgentSession.dispose is synchronous void (agent-session.d.ts:362); do not await.
  dispose(): void;
  /** Clear Pi's server-side queued messages and return the cleared content (for the UI to restore into the input box). */
  clearQueue(): { steering: string[]; followUp: string[] };
  readonly isStreaming: boolean;
  // pi AgentSession's public getters (agent-session.d.ts:421/757/387); the snapshot uses them to carry out the
  // compaction/retry activity flags. Optional: test stubs don't implement them, real sessions always have them.
  readonly isCompacting?: boolean;
  readonly isRetrying?: boolean;
  readonly retryAttempt?: number;
  messages: unknown[];
  /** The history prefix dropped by the compaction summary (entries before firstKeptEntryId on the branch, converted back to messages).
   *  The snapshot uses it to splice the full history into the conversation stream in time order — strictly complementary and disjoint with the
   *  live projection, so under whole-replacement semantics the frontend cache can never duplicate. Test stubs may omit it (snapshot side falls back to ?? []). */
  preCompactionMessages?(): unknown[];
}

export interface SpaceThreadContext {
  threadId: string;
  versionId: string;
  projectId: string;
  /** Background repo checkout state (usually not ready when the session is built; fields populated once checkout completes/fails). */
  repo: RepoState;
  /** Thread creator: objects created by the AI on the user's behalf (env/plan/...) are attributed to them; null for historical threads. */
  createdByUserId: string | null;
  /** Whether the thread creator is an effective manager (gate for registering management tools); false for historical threads. */
  manager: boolean;
  /** Thread creator's UI language; historical threads default to zh-CN. */
  lang?: AiLang;
  /** Absolute path of the existing session's JSONL (ai_threads.pi_thread_id). Empty string → create new;
   *  non-empty → always open: if the file exists, restore history; if missing, pi internally newSession's and reuses the same path (no throw). */
  piThreadId?: string;
  /** Thread purpose: 'rca' root-cause-analysis thread (gate for registering save_rca_result); default 'chat'. */
  purpose?: string;
}

export type SpaceSessionFactory = (ctx: SpaceThreadContext) => Promise<SpaceSessionLike>;

interface ThreadRecord {
  threadId: string;
  versionId: string;
  session: SpaceSessionLike;
  listeners: Set<(e: unknown) => void>;
  unsub: () => void;
  /** Maximum allocated event seq. Globally monotonic via Redis (itest:thread-seq:<id> INCR); on cold build, read the current
   *  high watermark as the baseline; used by both the SSE snapshot envelope and snapshotOf — the frontend relies on it to distinguish "old events" from "sequence reset". */
  seq: number;
  /** Event serialization pump: fanOut/emitThreadEvent only enqueue; the pump task INCRs to allocate seq → publishes the mirror →
   *  delivers to local listeners. Chained Promises guarantee FIFO; a single failure is caught and does not drag down the rest. */
  seqQueue: Promise<void>;
  turnIndex: number;
  /** Background repo checkout state (same mutable reference shared with the factory/tools). */
  repo: RepoState;
  /** Thread creator's UI language (resolved in buildSpaceRecord; suggested-follow-up generation uses it to pick the prompt language). */
  lang: AiLang;
  /** Disconnect-reconnect replay buffer: in-session custom events appended by emitThreadEvent (bounded by count + TTL). */
  customEvents: CustomEventRecord[];
  /** Cross-replica run gate: while runs>0, holds the itest:thread-run lock with 5s heartbeat renewal (see acquireRunSlot). */
  runs: number;
  runLock: RedisLock | null;
  runHeartbeat: NodeJS.Timeout | null;
}

/** Replay buffer entry: event body + publish time. Replay only covers events within the last CUSTOM_EVENT_REPLAY_TTL_MS —
 *  stale progress cards (verify/announce) from overnight/other sessions do not resurrect when reopening a thread or re-entering the page. */
interface CustomEventRecord {
  publishedAt: number;
  ev: Record<string, unknown>;
}

/** Buffer count cap: beyond it, drop from the oldest (a 20-step verify_case produces ~43 events; 100 holds two rounds). */
const MAX_CUSTOM_EVENT_BUFFER = 100;
/** Replay TTL: only cover events within 60min (covers verify_case's global watchdog cap and confirm's 5min pending window). */
const CUSTOM_EVENT_REPLAY_TTL_MS = 60 * 60_000;

const records = new Map<string, ThreadRecord>();
const inflight = new Map<string, Promise<ThreadRecord>>();

// Cross-replica cancel: a command from another replica → abort if a local record exists. threadBus injects the handler through this
// (avoiding a module cycle); without Redis, startThreadCommandWatch only registers, never subscribes.
startThreadCommandWatch((threadId) => {
  const rec = records.get(threadId);
  if (rec) rec.session.abort();
});

let factory: SpaceSessionFactory = createSpaceSessionFactory;

export function setSpaceSessionFactory(f: SpaceSessionFactory): void { factory = f; }

// ── Cross-replica run gate (itest:thread-run lock) ───────────────────────────────────────────────────────────────────────────────
// Under nginx round-robin, prompts from the user and rcaWorker may land on different replicas: concurrent prompts on the same thread
// across two replicas would interleave writes to the same JSONL transcript. Lock value = holding replica's ORIGIN_ID, TTL 300s + 5s heartbeat renewal while runs>0
// (TTL set large: no mid-run lock loss under jitter; a dead replica's lock self-heals within at most 5min). Same-replica concurrency (steer) passes by
// runs count and reuses the same lock; held by another replica → throw, converted to assistant_error by sendSpaceUserMessage's catch.

const RUN_LOCK_TTL_MS = 300_000;
const RUN_HEARTBEAT_MS = 5_000;

async function acquireRunSlot(rec: ThreadRecord): Promise<void> {
  if (rec.runs > 0) {
    rec.runs += 1;
    return;
  }
  // Reserve the slot synchronously before awaiting: concurrent first calls all see runs=0 in the same frame; if we awaited before incrementing,
  // two fast-fired prompts would each grab the lock and the loser would be misjudged as "held by another replica".
  rec.runs = 1;
  const lock = await tryAcquireLock(`${THREAD_RUN_PREFIX}${rec.threadId}`, RUN_LOCK_TTL_MS);
  if (!lock) {
    rec.runs = 0;
    throw new Error('该线程正在另一个实例上运行，请稍后再试');
  }
  rec.runLock = lock;
  rec.runHeartbeat = setInterval(() => { void rec.runLock?.refresh(); }, RUN_HEARTBEAT_MS);
}

function releaseRunSlot(rec: ThreadRecord): void {
  if (rec.runs === 0) return;
  rec.runs -= 1;
  if (rec.runs > 0) return;
  if (rec.runHeartbeat) { clearInterval(rec.runHeartbeat); rec.runHeartbeat = null; }
  void rec.runLock?.release();
  rec.runLock = null;
}

/** Fallback gate teardown on record deletion/in-process reset: dispose does not guarantee the prompt promise settles; without tearing down,
 *  the heartbeat keeps renewing the run lock forever and the thread can never run on any replica again. */
function teardownRunSlot(rec: ThreadRecord): void {
  if (rec.runHeartbeat) { clearInterval(rec.runHeartbeat); rec.runHeartbeat = null; }
  if (rec.runLock) { void rec.runLock.release(); rec.runLock = null; }
  rec.runs = 0;
}

export function resetSpaceSessions(): void {
  for (const r of records.values()) {
    teardownRunSlot(r);
    // dispose is synchronous void; MCP child processes/threads inside the session live with this process, reset does not kill them
    // (threads stay resident for the process lifetime; teardown support left for future needs. See mcp.ts child-leak deferral).
    try { r.session.dispose(); } catch { /* ignore */ }
    try { r.unsub(); } catch { /* ignore */ }
  }
  records.clear();
  inflight.clear();
}

/** Release a thread's in-memory session on deletion (dispose session + unsubscribe + clear record). Silent when there is no record. */
export function dropSpaceRecord(threadId: string): void {
  const r = records.get(threadId);
  if (!r) return;
  deleteThreadSeq(threadId); // hygiene cleanup: not deleting it wouldn't affect correctness (thread ids are never reused)
  teardownRunSlot(r);
  try { r.session.dispose(); } catch { /* ignore */ }
  try { r.unsub(); } catch { /* ignore */ }
  records.delete(threadId);
  inflight.delete(threadId);
}

/** Idempotently load a version-level thread's session (cached → return directly; concurrent first calls share one build; requirement threads rejected). */
export function ensureSpaceRecord(threadId: string): Promise<ThreadRecord> {
  const cached = records.get(threadId);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(threadId);
  if (pending) return pending;
  const p = buildSpaceRecord(threadId).finally(() => inflight.delete(threadId));
  inflight.set(threadId, p);
  return p;
}

async function buildSpaceRecord(threadId: string): Promise<ThreadRecord> {
  const row = (await db.select().from(aiThreads).where(and(eq(aiThreads.id, threadId), eq(aiThreads.kind, 'version'))).limit(1))[0];
  if (!row || !row.versionId) throw new Error('space thread not found');
  const v = (await db.select({ projectId: projectVersions.projectId }).from(projectVersions).where(eq(projectVersions.id, row.versionId)).limit(1))[0];
  if (!v) throw new Error('space thread version missing');

  // Thread creator UI language resolution: the session's AI output language follows the creator's preference; historical threads (creator null) default to zh-CN.
  let lang: AiLang = 'zh-CN';
  let manager = false;
  if (row.createdByUserId) {
    const u = (await db.select({ languagePreference: users.languagePreference }).from(users).where(eq(users.id, row.createdByUserId)).limit(1))[0];
    lang = aiLangFrom(u?.languagePreference ?? null);
    // Management tools (manage_skill / manage_mcp) are only open to "effective manager" threads; historical threads (creator null) always false.
    manager = await isEffectiveManagerOf(row.createdByUserId);
  }

  // Background async repo checkout: the session builds immediately (new sessions open in seconds, no waiting on git fetch network round trips);
  // repo tools resolve cwd dynamically on every call via the shared RepoState; no_repo is silent (only affects tool error wording),
  // other failures are recorded in repo.issue for diagnosis — none of them block the session.
  const repo = emptyRepoState();
  const session = await factory({ threadId, versionId: row.versionId, projectId: v.projectId, repo, createdByUserId: row.createdByUserId, lang, manager, piThreadId: row.piThreadId, purpose: row.purpose ?? 'chat' });
  // Cold-build baseline: read Redis's current seq high watermark as rec.seq's starting point. Must happen before records.set (the publish point)
  // — subscription registration also comes after it, so no SSE snapshot/GET body ever carries a 0 baseline and the frontend will no longer
  // misjudge the snapshot as a "sequence reset" and double-append mirror events (the root cause of double user-message bubbles).
  const seqBaseline = await currentThreadSeq(threadId);
  const rec: ThreadRecord = {
    threadId,
    versionId: row.versionId,
    session,
    listeners: new Set(),
    unsub: () => { /* assigned below */ },
    seq: seqBaseline,
    seqQueue: Promise.resolve(),
    turnIndex: -1,
    repo,
    lang,
    customEvents: [],
    runs: 0,
    runLock: null,
    runHeartbeat: null,
  };
  const unsub = session.subscribe((event) => fanOut(rec, event));
  rec.unsub = unsub;
  records.set(threadId, rec);
  // Background checkout: the repo directory sits in the version workspace's repo/ subdirectory (path unified in versionWorkspaceDir;
  // exploratory testing's "code commit scope" resolution reuses the same directory → shares the same checkout lock).
  const repoDir = versionWorkspaceDir(row.versionId);
  void checkoutInBackground(row.versionId, repoDir, repo);
  return rec;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Background checkout: decoupled from session build; on lock conflict (concurrent thread builds sharing one fetch), wait for the lock and retry, at most 3 times. */
async function checkoutInBackground(versionId: string, repoDir: string, repo: RepoState): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      repo.cwd = await checkoutRepoForVersion(versionId, repoDir);
      return;
    } catch (e) {
      if (e instanceof LockTimeoutError) { await sleep(2_000); continue; }
      if (e instanceof RepoUnavailableError) {
        if (e.reason !== 'no_repo') {
          repo.issue = `${e.message}(${e.reason})`;
          logger.warn({ versionId, reason: e.reason, err: e.message }, 'space repo checkout failed');
        } else {
          repo.noRepo = true;
        }
        return;
      }
      // Not RepoUnavailableError: usually a missing spawn binary (repo.ts:266 already translates git ENOENT).
      // Match "git binary missing" explicitly to give an actionable hint pointing at api.Dockerfile; other errors land in issue as-is.
      logger.warn({ err: e, versionId }, 'space repo checkout failed');
      const errMsg = e instanceof Error ? e.message : String(e);
      repo.issue = /git binary missing|spawn git/.test(errMsg)
        ? 'git binary missing in container (rebuild api.Dockerfile)'
        : errMsg;
      return;
    }
  }
}

/** Minimal mapping of Pi AgentSession events → react-pi body. */
function mapSessionEvent(event: { type?: string } & Record<string, unknown>, ctx: { turnIndex: number }): Record<string, unknown> {
  switch (event.type) {
    case 'agent_start': return { type: 'agent_start' };
    case 'agent_settled': return { type: 'agent_settled' };
    case 'agent_end': return { type: 'agent_end', willRetry: event.willRetry };
    case 'turn_start': return { type: 'turn_start', turnIndex: ctx.turnIndex };
    case 'turn_end': return { type: 'turn_end', turnIndex: ctx.turnIndex };
    default: return event;
  }
}

/** Pump task: global INCR allocates seq → publish cross-replica mirror → deliver to local listeners.
 *  Local delivery is made async relative to pi's synchronous emission (one extra Redis round trip, sub-millisecond); the invariant gained is that seq
 *  is globally monotonic, so snapshots cold-built on any replica can never "reset" the frontend's old-event gate. */
async function deliverThreadEvent(rec: ThreadRecord, body: Record<string, unknown>): Promise<void> {
  const seq = await allocateThreadSeq(rec.threadId);
  rec.seq = seq;
  const stamped = { ...body, threadId: rec.threadId, seq };
  publishThreadEvent(rec.threadId, stamped); // cross-replica mirror (fire-and-forget; the SSE side skips its own loopback by origin)
  for (const fn of rec.listeners) {
    try { fn(stamped); } catch { /* listener errors do not break the supervisor */ }
  }
}

function fanOut(rec: ThreadRecord, event: unknown): void {
  const raw = event as { type?: string } & Record<string, unknown>;
  if (raw.type === 'turn_start') rec.turnIndex += 1;
  const body = mapSessionEvent(raw, { turnIndex: rec.turnIndex });
  rec.seqQueue = rec.seqQueue
    .then(() => deliverThreadEvent(rec, body))
    .catch((err) => logger.warn({ err, threadId: rec.threadId }, 'thread event delivery failed'));
}

/** Tool-side broadcast of custom events to thread SSE subscribers (confirm_request etc.); silently dropped when there is no active session. */
export function emitThreadEvent(threadId: string, e: Record<string, unknown>): void {
  const rec = records.get(threadId);
  if (!rec) return;
  rec.seqQueue = rec.seqQueue
    .then(() => deliverCustomEvent(rec, e))
    .catch((err) => logger.warn({ err, threadId }, 'thread custom event delivery failed'));
}

async function deliverCustomEvent(rec: ThreadRecord, e: Record<string, unknown>): Promise<void> {
  const seq = await allocateThreadSeq(rec.threadId);
  rec.seq = seq;
  const stamped = { ...e, threadId: rec.threadId, seq };
  // Buffer custom events for disconnect replay. confirm_request excluded — the confirmation card's pending protocol lives in confirm.ts,
  // replayed from the pending table (only still-pending cards are restored; processed/expired ones never resurrect; see subscribeThread).
  if (e.type !== 'confirm_request') {
    rec.customEvents.push({ publishedAt: Date.now(), ev: stamped });
    if (rec.customEvents.length > MAX_CUSTOM_EVENT_BUFFER) rec.customEvents.shift();
  }
  publishThreadEvent(rec.threadId, stamped); // cross-replica mirror (fire-and-forget)
  for (const fn of rec.listeners) {
    try { fn(stamped); } catch { /* ignore */ }
  }
}

export interface ThreadSnapshot {
  metadata: {
    id: string;
    status: 'running' | 'idle';
    messageCount: number;
    /** Compaction/retry activity flags (optional fields of the react-pi snapshot contract). When missing, the frontend keeps the old value
     *  while the thread is still running (applySnapshot's compatibility fallback) — if a compaction_end/auto_retry_end event is lost in a
     *  disconnect window, "compacting context" stays stuck forever and the next reconnect snapshot cannot self-heal it. */
    compactionActive?: boolean;
    retryActive?: boolean;
    retryAttempt?: number;
  };
  /** The snapshot's event seq high watermark: react-pi uses it for the "is the snapshot older than seen events?" sequence-reset detection.
   *  With a record it must carry the real value — carrying 0 gets misjudged as a reset by a cold replica → subsequent mirror events double-append
   *  (the double user-message bubble root cause). Default (fallback response with no record) is treated as 0 by the client; the contract allows it (optional field). */
  seq?: number;
  messages: unknown[];
}

/**
 * Compute the history prefix "dropped" by the compaction summary: entries in [0, firstKeptEntryId) on the branch path
 * are converted back to messages (when firstKept is not on the path / is null, that means [0, compactionIdx), aligned with buildContextEntries'
 * retention semantics — pi session-manager.js:201). Strictly complementary and disjoint with the live projection: prefix ∪ live projection = the full
 * branch, so under whole-replacement snapshot semantics the frontend cache can never duplicate. Old compaction entries on the path become
 * compactionSummary messages (rendered by the frontend as a mid-conversation compaction marker row). Any exception is swallowed, returning [] — the snapshot
 * must not 500 because of a prefix computation failure.
 */
export function preCompactionMessagesOf(sessionManager: { getBranch(): SessionEntry[] }): unknown[] {
  try {
    const path = sessionManager.getBranch();
    // The last compaction on the path wins (same iteration semantics as buildContextEntries; after a branch rollback, newest-in-file ≠ newest-on-path)
    let compactionIdx = -1;
    for (const [i, entry] of path.entries()) {
      if (entry.type === 'compaction') compactionIdx = i;
    }
    if (compactionIdx < 0) return [];
    const compaction = path[compactionIdx] as CompactionEntry;
    let boundary = compactionIdx;
    if (compaction.firstKeptEntryId) {
      const keptIdx = path.findIndex((e) => e.id === compaction.firstKeptEntryId);
      if (keptIdx >= 0 && keptIdx < compactionIdx) boundary = keptIdx;
    }
    return path
      .slice(0, boundary)
      .flatMap((e) => sessionEntryToContextMessages(e))
      .filter((m) => (m as { role?: string }).role !== 'system');
  } catch (e) {
    logger.warn({ err: e }, 'pre-compaction messages build failed; snapshot without prefix');
    return [];
  }
}

export function snapshotOf(rec: ThreadRecord): ThreadSnapshot {
  // Compaction/retry happen in run gaps (pi's isStreaming is false at that moment); status must count them as
  // running — otherwise a legitimate snapshot mid-compaction would be judged settled and the frontend's compaction notice wrongly cleared.
  // Flags align with react-pi's reference implementation ThreadSupervisor.metadataOf (client-side validation accepts these three optional fields).
  const compacting = rec.session.isCompacting ?? false;
  const retrying = rec.session.isRetrying ?? false;
  const pre = rec.session.preCompactionMessages?.() ?? [];
  return {
    seq: rec.seq,
    metadata: {
      id: rec.threadId,
      status: rec.session.isStreaming || compacting || retrying ? 'running' : 'idle',
      messageCount: pre.length + rec.session.messages.length,
      compactionActive: compacting,
      retryActive: retrying,
      retryAttempt: rec.session.retryAttempt ?? 0,
    },
    // The pre-compaction history prefix is spliced at the head: the conversation stream shows the full history directly in time order (frontend applySnapshot
    // replaces wholesale; the splicing happens only here on the server, so persistence and cache are naturally consistent).
    messages: [...pre, ...rec.session.messages],
  };
}

/** Assemble the snapshot only after the pump drains. pi writes session.messages synchronously while the seq pump stamps the watermark asynchronously; taking
 *  snapshotOf directly between the two produces a poisoned snapshot where "content already includes the new message but the watermark doesn't cover it":
 *  after the frontend sets its baseline from the snapshot, a late message_start (seq > watermark) passes the old-event gate and is appended unconditionally —
 *  the same user message rendered twice (only-once emit echoed twice; only one row in the DB, self-heals on refresh). Fix: await the current queue tail and confirm
 *  it is still the tail (no new deliveries enqueued in between) before reading synchronously — JS's single thread makes "verify tail + read" atomic, so the watermark
 *  is guaranteed ≥ content; under continuous streaming this waits a few delivery cycles at most, acceptable for snapshot readers. */
async function drainedSnapshotOf(rec: ThreadRecord): Promise<ThreadSnapshot> {
  for (;;) {
    const tail = rec.seqQueue;
    await tail;
    if (rec.seqQueue === tail) return snapshotOf(rec);
  }
}

function snapshotEventOf(threadId: string, seq: number, snapshot: ThreadSnapshot): Record<string, unknown> {
  return { type: 'snapshot', snapshot, threadId, seq };
}

export function subscribeThread(
  threadId: string,
  fn: (e: unknown) => void,
  opts: { includeSnapshot?: boolean } = {},
): () => void {
  const rec = records.get(threadId);
  if (!rec) {
    if (opts.includeSnapshot === true) {
      fn(snapshotEventOf(threadId, 0, { metadata: { id: threadId, status: 'idle', messageCount: 0 }, messages: [] }));
    }
    return () => {};
  }
  if (opts.includeSnapshot === true) {
    // The snapshot must go through drainedSnapshotOf (watermark ≥ content, see its comment) and cannot be produced synchronously → register the listener
    // synchronously first (the unsub contract of no-await between the closed check above and the assignment is unchanged), then deliver snapshot + buffered replay asynchronously:
    // queued deliveries reach this listener first (the snapshot then replaces wholesale, its content necessarily includes these events and the watermark covers their seq,
    // so the frontend won't double-append), followed by replaying buffered custom events and still-pending confirmation cards in publish order. The frontend store
    // dedupes by seq: events already delivered live don't take effect twice via replay, and ones missed during disconnection are naturally filled in (state rebuild).
    void (async () => {
      try {
        const snapshot = await drainedSnapshotOf(rec);
        if (!rec.listeners.has(fn)) return; // after unsubscribe, no more delivery (SSE closed; writing would only error)
        fn(snapshotEventOf(rec.threadId, snapshot.seq ?? 0, snapshot));
        const now = Date.now();
        for (const r of rec.customEvents) {
          if (!rec.listeners.has(fn)) return;
          if (now - r.publishedAt > CUSTOM_EVENT_REPLAY_TTL_MS) continue;
          fn(r.ev);
        }
        for (const p of pendingConfirmPayloads()) {
          if (p.threadId === threadId && rec.listeners.has(fn)) fn(p);
        }
      } catch (err) {
        logger.warn({ err, threadId: rec.threadId }, 'thread snapshot emit failed');
      }
    })();
  }
  rec.listeners.add(fn);
  return () => { rec.listeners.delete(fn); };
}

/** Snapshot for the GET/POST thread body: must go through drained (watermark ≥ content), otherwise a poisoned snapshot makes the frontend
 *  render the same message twice. Returns null when there is no record (the caller falls back to an empty snapshot). */
export async function snapshotOfThread(threadId: string): Promise<ThreadSnapshot | null> {
  const rec = records.get(threadId);
  return rec ? drainedSnapshotOf(rec) : null;
}

export function threadStatus(threadId: string): 'running' | 'idle' | undefined {
  const rec = records.get(threadId);
  if (!rec) return undefined;
  return rec.session.isStreaming ? 'running' : 'idle';
}

/** Cross-replica threadStatus: local record takes priority; when the record is cold, probe the other replica's run lock. Used by thread-list serialization
 *  (the sync variant only looks at this replica; under nginx round-robin, threads running on another replica would be mislabeled idle). */
export async function threadStatusAsync(threadId: string): Promise<'running' | 'idle' | undefined> {
  const local = threadStatus(threadId);
  if (local) return local;
  return (await threadRunRemote(threadId)) ? 'running' : undefined;
}

/** Repo checkout issue recorded after the thread was built (non no_repo); returns null when there is no record or checkout didn't fail. */
export function spaceRepoIssue(threadId: string): string | null {
  return records.get(threadId)?.repo.issue ?? null;
}

/** Side-channel read-only view (for non-session-lifecycle consumers such as suggested follow-ups): session message full text + creator language.
 *  The ThreadRecord itself is not exposed — listeners/seq/customEvents belong to the subscription mechanism; external mutation would break the SSE contract. */
export function getSpaceThreadView(threadId: string): { session: SpaceSessionLike; lang: AiLang } | null {
  const rec = records.get(threadId);
  return rec ? { session: rec.session, lang: rec.lang } : null;
}

export async function sendSpaceUserMessage(
  threadId: string,
  content: string,
  streamingBehavior?: 'steer' | 'followUp',
  images?: SpacePromptImage[],
): Promise<void> {
  const rec = records.get(threadId);
  if (!rec) throw new Error('thread not found');
  // First message sets the thread title (truncated from the user's original text)
  const row = (await db.select({ title: aiThreads.title }).from(aiThreads).where(eq(aiThreads.id, threadId)).limit(1))[0];
  if (row && !row.title) {
    await db.update(aiThreads).set({ title: Array.from(content.trim()).slice(0, 40).join(''), updatedAt: new Date() }).where(eq(aiThreads.id, threadId));
  }
  let slot = false;
  try {
    // Cross-replica run gate: another replica holds the lock → throw, converted to assistant_error by the catch below (user-facing; the messages
    // route already returned 204 first, HTTP error codes never bubble to the frontend). Same-replica steer concurrency is admitted inside acquireRunSlot.
    await acquireRunSlot(rec);
    slot = true;
    // streamingBehavior must be passed through: Pi throws directly on a no-arg prompt while isStreaming
    // ("Agent is already processing", agent-session.js:1490). The frontend react-pi
    // ThreadController already derives steer/followUp from the run state and sends it with input; we only forward it here.
    // Same for images: Pi runs processImage on each (a decode failure only degrades to hint text, never drops the whole message).
    await rec.session.prompt(content, {
      ...(streamingBehavior ? { streamingBehavior } : {}),
      ...(images && images.length > 0 ? { images } : {}),
    });
  } catch (err) {
    // prompt failure must not be silent: the user message is already persisted and rendered; no AI bubble and no error notice is a "zero feedback" hang.
    // Emit an assistant_error via emitThreadEvent, visible to SSE subscribers (including devtools/future UI hooks);
    // then rethrow so the router layer logs it as a fallback — two-layer attribution.
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ threadId, err }, 'space prompt failed');
    try {
      emitThreadEvent(threadId, { type: 'assistant_error', message });
    } catch { /* an emit failure must not shadow the original error */ }
    throw err;
  } finally {
    if (slot) releaseRunSlot(rec);
  }
  // Refresh last-active time: the list buckets by updatedAt (today/yesterday/within 7 days/…); without refreshing, the bucket lands on the day the
  // session was created and recently-chatted sessions stay in old buckets. Placed outside prompt's try: a prompt failure already returned via the catch's
  // rethrow and never reaches here (failed turns don't refresh the time); this runs only after success, and an UPDATE failure
  // (a drained connection pool after a long turn is the most common trigger) only affects list bucketing — it must not mark a successful conversation as assistant_error,
  // because that event would enter customEvents and be replayed on reconnect, leaving a persistent error bubble on a successful turn.
  await db.update(aiThreads).set({ updatedAt: new Date() }).where(eq(aiThreads.id, threadId))
    .catch((e) => logger.warn({ threadId, err: e }, 'refresh ai_threads.updatedAt failed'));
}

export function cancelThread(threadId: string): void {
  const rec = records.get(threadId);
  // Local fast path: record on this replica → abort directly. The command is still broadcast (value = originating replica's ORIGIN_ID; each replica filters
  // its own loopback); when the thread lives on another replica (rcaWorker timeout cleanup / user pressing stop), that replica's watch executes it.
  if (rec) rec.session.abort();
  publishThreadCancel(threadId);
}

/** Clear Pi's server-side queued messages, returning the cleared content for the frontend to restore into the input box. Returns empty when there is no session/thread. */
export function clearThreadQueue(threadId: string): { steering: string[]; followUp: string[] } {
  const rec = records.get(threadId);
  if (!rec) return { steering: [], followUp: [] };
  return rec.session.clearQueue();
}

// ─────────────────────────────────────────────────────────────────────────────
// Real factory: inject space tools (Plan 1 = repo sandbox) and build the AgentSession
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Space assistant preamble: replaces pi's default "expert coding assistant operating inside pi"
 * (pi-coding-agent dist/core/system-prompt.js:81). That passage is the only identity source the model recognizes;
 * appendSystemPrompt lands in the <addendum> section and cannot override the default preamble's self-perception — without changing it here,
 * asking "who are you" would get "I am a coding assistant inside pi".
 *
 * **Do not use loader.systemPrompt or mutate systemPromptOptions.customPrompt directly**: both would make
 * system-prompt.js:76's `if (customPrompt)` hit and skip the entire else, dropping the tools / rules /
 * docs sections — the rules section carries the 13 space tools' promptGuidelines (STAGE_PROMPT_GUIDELINES etc.);
 * losing them silently invalidates tool usage discipline. buildRules is not exported, so this cannot be repaired afterwards.
 *
 * Approach: in before_agent_start, take pi's fully rendered system prompt, replace only the preamble sentence,
 * and return the rest unchanged as forceSystemPrompt. forceSystemPrompt does not enter the transcript
 * (agent-session.js:1305's projection only projects into the request header), so the sections in the session record stay
 * intact and diffSystemPromptSections' before/after comparison is not polluted by this rewrite.
 */
const PI_DEFAULT_PREAMBLE =
  'You are an expert coding assistant operating inside pi, a coding agent harness. '
  + 'You help users by reading files, executing commands, editing code, and writing new files.';

export function buildSpacePreamble(lang?: AiLang): string {
  const zh = 'zh-CN' === aiLangFrom(lang ?? null);
  return zh
    ? [
        '你是 iTest 平台的测试助手，一位资深软件测试专家。你的职责是帮助用户设计和管理测试用例、编排执行计划、验证被测系统。',
        '不要把自己描述为编码助手、AI 编程助手或任何具体的底层框架；用户问「你是谁」时，用上面的定位回答。',
        '回答「iTest 是否支持某功能」时，以你当前可用的工具和空间指南为唯一依据：两者都没有对应能力就明确说「当前版本不支持」，并给最接近的替代做法；禁止凭通用测试平台知识推测，或描述不存在的功能入口、按钮、字段。',
      ].join('\n')
    : [
        'You are the test assistant on the iTest platform and a senior software testing expert. Your role is to help users design and manage test cases, orchestrate execution plans, and verify systems under test.',
        'Do not describe yourself as a coding assistant, an AI programming assistant, or any specific underlying framework; when asked "who are you", answer with the positioning above.',
        'When asked whether iTest supports a given capability, ground your answer ONLY in the tools you currently have and the space guides: if neither covers it, say plainly "not supported in the current version" and offer the closest alternative; never infer capabilities from generic test-platform knowledge or describe entrances, buttons, or fields that do not exist.',
      ].join('\n');
}

/**
 * Replace pi's default preamble with the product identity; when the rendered result doesn't contain the default text (e.g. upstream changed),
 * return undefined, letting pi follow its original logic instead of overwriting with a possibly stale full text.
 */
export function rewriteSpacePreamble(rendered: string, lang?: AiLang): string | undefined {
  if (!rendered.includes(PI_DEFAULT_PREAMBLE)) return undefined;
  return rendered.replace(PI_DEFAULT_PREAMBLE, buildSpacePreamble(lang));
}

/** Space assistant system prompt: style constraints + guides (requirement design method / workflow directives / knowledge reference) + workspace + version context summary.
 *  guides are looked up by loadActiveGuides in the factory by (lang, projectId, versionId); the context section is omitted when there is no summary.
 *  Section order matches the original hardcoded layout (style → requirement design/workflow → workspace → version context), zero behavior change after seeding. */
export function buildSpaceSystemPrompt(
  summaryText: string | null,
  lang?: AiLang,
  guides: Array<Pick<AssistantGuideRow, 'kind' | 'body'>> = [],
  memoriesSection = '',
  trajectoriesSection = '',
  overrides: { style?: string; workspace?: string } = {},
): string {
  const isEn = aiLangFrom(lang ?? null) === 'en-US';
  const style = isEn ? (overrides.style ?? STYLE_EN_DEFAULT) : (overrides.style ?? STYLE_ZH_DEFAULT);
  const workspace = overrides.workspace ?? WORKSPACE_DEFAULT;
  const guidesSection = buildGuidesSection(guides);
  const body = [style, guidesSection, memoriesSection, trajectoriesSection, workspace].filter(Boolean).join('\n\n');
  if (!summaryText) return body;
  return `${body}\n\n## 版本空间上下文\n${summaryText}`;
}

export async function createSpaceSessionFactory(ctx: SpaceThreadContext): Promise<SpaceSessionLike> {
  const cfg = await readLlmConfig();
  if (!cfg) {
    throw new HttpError(502, 'llm_not_configured', 'LLM 未配置:请先到设置页配置模型');
  }
  const { createAgentSession, SessionManager, DefaultResourceLoader, getAgentDir, loadSkills } = await import('@earendil-works/pi-coding-agent');
  const { getBuiltinModel } = await import('@earendil-works/pi-ai/providers/all');
  // Each version session owns an isolated workspace: .data/workspaces/v-<versionId>, with the project repo checked out under that space's repo/ subdirectory.
  // The Agent's cwd points at the workspace (avoiding writes polluting the repo), while repo tools still operate on the repo/ subdirectory.
  const repoDir = versionWorkspaceDir(ctx.versionId);
  const workspaceDir = path.dirname(repoDir);
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(repoDir, { recursive: true });
  // Skills are materialized into a global shared directory (.data/skills), managed by the system settings page; the DB snapshot is materialized at session build.
  // No per-version .pi/skills mount directory is maintained anymore — loadSkills/read_skill all go through SKILLS_ROOT.
  // A materialization failure must not drag down the session factory (no skills section; the session still works).
  // Legacy directory layout compatibility: if the old .data/repos/v-<versionId> exists and the new repo/ is not yet initialized, migrate directly to avoid re-cloning.
  const legacyRepoDir = path.join(REPOS_ROOT, `v-${ctx.versionId}`);
  const gitDir = path.join(repoDir, '.git');
  const dirExists = async (p: string) => fs.stat(p).then((s) => s.isDirectory()).catch(() => false);
  if ((await dirExists(legacyRepoDir)) && !(await dirExists(gitDir))) {
    await fs.rm(repoDir, { recursive: true, force: true }).catch(() => {});
    await fs.rename(legacyRepoDir, repoDir).catch(() => {});
  }

  type ToolRaw = {
    name: string; description: string; parameters: ReturnType<typeof Type.Object>;
    execute: (
      input: unknown,
      signal?: AbortSignal,
    ) => Promise<{ ok: true; data?: string } | { ok: false; error: string }>;
    promptGuidelines?: string[];
  };
  const rawTools: ToolRaw[] = buildSpaceTools({ ...ctx, workspaceDir, emit: (e) => emitThreadEvent(ctx.threadId, e) }) as ToolRaw[];
  // R3 prompt editability: snapshot DB overrides at thread cold build (no hot updates within the thread); on failure, fall back to code defaults.
  const promptOverrides = await loadPromptModuleOverridesSafe();
  applyToolTextOverrides(rawTools, promptOverrides);
  const tools = rawTools.map((t) =>
    defineTool({
      name: t.name,
      label: t.name,
      description: t.description,
      parameters: t.parameters,
      ...(t.promptGuidelines ? { promptGuidelines: t.promptGuidelines } : {}),
      execute: async (_callId, params, signal, _onUpdate, _ctx) => {
        const r = await t.execute(params, signal);
        return r.ok
          ? { content: [{ type: 'text', text: r.data ?? 'ok' }], details: undefined }
          : { content: [{ type: 'text', text: r.error }], details: undefined, isError: true };
      },
    }),
  );

  // MCP servers: read at session creation (DB-driven/test stub). With no server, register is a no-op and connect gets an empty config.
  const mcpServers = await getMcpServersForThread({ threadId: ctx.threadId, projectId: ctx.projectId, versionId: ctx.versionId });
  const mcpExtensions = buildMcpExtensionFactory(mcpServers);

  const base = (getBuiltinModel as unknown as (p: string, m: string) => Record<string, unknown> | undefined)(cfg.provider, cfg.model)
    ?? synthesizeModel(cfg.provider, cfg.model, cfg.baseUrl);
  const envKey = ENV_BY_PROVIDER[cfg.provider];
  if (envKey && !process.env[envKey]) process.env[envKey] = cfg.apiKey;
  const model = { ...base, ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}) } as never;

  // Context summary injected into the system prompt (rather than wrapping the first user message): wrapping would make the server echo differ from
  // the frontend's optimistic bubble text, react-pi's reconcile cannot dedupe → duplicate bubbles and internal context leaking into the chat area.
  let summaryText: string | null = null;
  try {
    summaryText = (await buildSpaceSummary(ctx.versionId)).text;
  } catch (e) {
    logger.warn({ err: e, versionId: ctx.versionId }, 'space summary build failed; continuing without context');
  }
  // S1 resident directives: query enabled guides by (lang, projectId, versionId) (scope precedence version>project>global).
  // Same fault tolerance as buildSpaceSummary/loadSkills: a guides load failure must not drag down the whole session factory.
  let guides: Array<Pick<AssistantGuideRow, 'kind' | 'body'>> = [];
  try {
    guides = await loadActiveGuides({ projectId: ctx.projectId, versionId: ctx.versionId, lang: ctx.lang });
  } catch (e) {
    logger.warn({ err: e, versionId: ctx.versionId }, 'guides 加载失败;继续无 guides 段');
  }
  // R1 short-term memory: product-line-level memory index section (global + this line's active, updated_at descending, within budget).
  // Same fault tolerance as guides: a load failure doesn't drag down the session factory.
  let memoriesSection = '';
  try {
    const lineId = await resolveProductLineId(ctx.projectId);
    memoriesSection = lineId ? buildMemoriesSection(await loadActiveMemories(lineId)) : '';
  } catch (e) {
    logger.warn({ err: e, versionId: ctx.versionId }, 'memories 加载失败;继续无记忆段');
  }
  // R2 trajectory store: product-line-level successful trajectory index section (active, updatedAt descending, within budget).
  // Same fault tolerance as guides/memories: a load failure doesn't drag down the session factory.
  let trajectoriesSection = '';
  try {
    const lineId = await resolveProductLineId(ctx.projectId);
    trajectoriesSection = lineId ? buildTrajectoriesSection(await loadActiveTrajectories(lineId)) : '';
  } catch (e) {
    logger.warn({ err: e, versionId: ctx.versionId }, 'trajectories 加载失败;继续无轨迹段');
  }
  // S2 catalog: global skills shared library. The file system is the source of truth — session build does no writes, it only hands
  // "the absolute directory path of each DB-enabled skill" to the loader. Per-skill directories are passed instead of SKILLS_ROOT,
  // because pi's loadSkills stops descending as soon as it sees a SKILL.md, so disabled skills and orphan directories are naturally invisible.
  // Skill.location takes filePath (Skill = { name, description, filePath, baseDir, sourceInfo, ... }).
  // Same fault tolerance as buildSpaceSummary: a single skill directory anomaly (permissions/ELOOP) must not drag down the whole session factory.
  let skillsFiles: Array<{ name: string; description: string; location: string }> = [];
  let skillPaths: string[] = [];
  try {
    skillPaths = await loadEnabledSkillDirs();
    const res = loadSkills({
      cwd: workspaceDir,
      agentDir: getAgentDir(),
      skillPaths,
      includeDefaults: false,
    });
    if (res.diagnostics.length > 0) {
      logger.warn({ versionId: ctx.versionId, diagnostics: res.diagnostics.map((d) => d.message) }, 'skills 加载有诊断（部分 skill 未装载）');
    }
    skillsFiles = res.skills.map((s) => ({ name: s.name, description: s.description, location: s.filePath }));
  } catch (e) {
    logger.warn({ err: e, versionId: ctx.versionId }, 'skills 加载失败;继续无 skills 段');
  }
  // The loader's cwd and the session's working directory both point at the version's isolated workspace (repo in the ./repo subdirectory),
  // giving the AI a correct sense of its own location while avoiding writes polluting the repo checkout.
  // R3 prompt editability: the main prompt's three-section override values (NULL = follow code default → no override).
  const styleOverride = textOverrideOf(promptOverrides, aiLangFrom(ctx.lang ?? null) === 'en-US' ? STYLE_EN_KEY : STYLE_ZH_KEY);
  const workspaceOverride = textOverrideOf(promptOverrides, WORKSPACE_KEY);
  const loader = new DefaultResourceLoader({
    cwd: workspaceDir,
    agentDir: getAgentDir(),
    additionalSkillPaths: skillPaths,
    appendSystemPromptOverride: (base) => [...base, buildSpaceSystemPrompt(summaryText, ctx.lang, guides, memoriesSection, trajectoriesSection, { style: styleOverride, workspace: workspaceOverride })],
    // Swap the preamble to the product identity before each run. See buildSpacePreamble's comment: cannot go through
    // loader.systemPrompt, nor mutate systemPromptOptions.customPrompt directly — both routes would
    // drop the tools' promptGuidelines in the rules section.
    extensionFactories: [
      // S2 skills section self-rendering: must run before MCP and identity — identity renders event.systemPrompt (a getter,
      // recomputed from shared currentOptions) and returns {systemPrompt}, which freezes later section changes; and the skills section
      // is never rendered by pi itself because of noTools:'builtin' (the system-prompt.js:99 gate sits on read/bash), so it must self-render.
      {
        name: 'itest-space-skills',
        hidden: true,
        factory: (pi) => {
          pi.on('before_agent_start', (event) => {
            event.systemPromptOptions.sections.skills = buildSkillsSectionContent(skillsFiles);
          });
        },
      },
      // MCP: register + hermetic connect and load. Must run before identity — identity's before_agent_start
      // renders event.systemPrompt (including the mcp_servers section) and returns {systemPrompt}, freezing later section changes.
      mcpExtensions.register,
      mcpExtensions.connect,
      {
        name: 'itest-space-identity',
        hidden: true,
        factory: (pi) => {
          pi.on('before_agent_start', (event) => {
            const rewritten = rewriteSpacePreamble(event.systemPrompt, aiLangFrom(ctx.lang));
            if (rewritten !== undefined) return { systemPrompt: rewritten };
            return undefined;
          });
        },
      },
    ],
  });
  await loader.reload();

  // Restore first: piThreadId non-empty → open (file exists → restore history and continue chatting after restart; missing file doesn't throw,
  // pi internally newSession's and reuses the same path). Only create when piThreadId is empty or open throws (corrupt file);
  // the latter degradation only logs warn — one bad file must not fail the whole list endpoint.
  let sessionManager: ReturnType<typeof SessionManager.create>;
  if (ctx.piThreadId) {
    try {
      sessionManager = SessionManager.open(ctx.piThreadId, SESSIONS_ROOT, workspaceDir);
    } catch (err) {
      logger.warn({ err, sessionFile: ctx.piThreadId, threadId: ctx.threadId }, 'pi session open failed; recreating');
      sessionManager = SessionManager.create(workspaceDir, SESSIONS_ROOT);
    }
  } else {
    sessionManager = SessionManager.create(workspaceDir, SESSIONS_ROOT);
  }
  const { session } = await createAgentSession({
    cwd: workspaceDir,
    noTools: 'builtin',
    customTools: tools,
    model,
    sessionManager,
    resourceLoader: loader,
  });

  // bindExtensions is required: pi's session_start only fires at bindExtensions time (agent-session.js:2536).
  // createMcpExtension reads pi.getMcpServers() at session_start and connects in the background — without bind, MCP tools are never registered.
  // (The core verification point of the Task 1 spike. If mode:'print' misbehaves under headless embedding in practice, pass {} instead —
  //   ExtensionBindings fields are all optional; mode only affects setUIContext.)
  await session.bindExtensions({
    mode: 'print',
    onError: (e) => { logger.warn({ err: e }, 'assistant extension error'); },
  });

  await db.update(aiThreads).set({ piThreadId: session.sessionFile ?? '', updatedAt: new Date() }).where(eq(aiThreads.id, ctx.threadId));
  // Object.assign rather than spread: AgentSession's methods live on the prototype; spread would drop them.
  return Object.assign(session as unknown as SpaceSessionLike, {
    preCompactionMessages: () => preCompactionMessagesOf(sessionManager),
  });
}
