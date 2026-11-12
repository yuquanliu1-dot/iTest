import type { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';
import IORedis, { type Redis } from 'ioredis';
import { logger } from '../logger.js';

export interface RecorderTabEvent {
  kind: 'opened' | 'closed';
  tabRef: string;
  title?: string;
  url?: string;
}

/**
 * Serializable session metadata (no steps/tabs/ws). steps/tabs use append-style storage (Redis LIST); only meta is
 * the cached/cross-replica-shared object — the old implementation's "whole-record cache" would overwrite Redis wholesale at B-replica
 * persistSession time with a hydrated stale steps array (recording REST and WS already routinely land on different replicas → silent step loss).
 */
export interface RecorderMeta {
  sessionId: string;
  caseId: string;
  mode?: 'fresh' | 'append' | 'resume' | 'incognito';
  incognito?: boolean;
  resumeFromOrder?: number;
  /** Target URL passed in by the web console when starting recording; finish() uses it as one source for test_cases.url. */
  targetUrl?: string | null;
  /** test_sessions audit row id, set by the route that persisted it. */
  dbSessionId?: string;
}

/** In-process view = meta + this replica's WS handle (ws isn't serializable; unreachable when finish lands on another replica — current semantics). */
export interface RecorderSession extends RecorderMeta {
  ws?: WebSocket;
}

const sessions = new Map<string, RecorderSession>();
/** steps/tabs fallback without Redis (single container/dev/tests): append semantics isomorphic to the Redis version. */
const localSteps = new Map<string, unknown[]>();
const localTabs = new Map<string, RecorderTabEvent[]>();
const secret = process.env.RECORDER_TOKEN_SECRET ?? 'dev-secret-change-me';
if (secret === 'dev-secret-change-me' && process.env.NODE_ENV === 'production') {
  logger.warn('RECORDER_TOKEN_SECRET is using the default dev value; set a real secret in production');
}
const SESSION_TTL_S = 3600;
const SESSION_PREFIX = 'itest:rec:';
const STEPS_PREFIX = 'itest:rec-steps:';
const TABS_PREFIX = 'itest:rec-tabs:';

let _redis: Redis | null = null;
function getRedisIfReady(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  if (!_redis) {
    _redis = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
    _redis.on('error', () => undefined);
  }
  return _redis;
}

/** Test seam (modeled on cache.ts): inject/clear the Redis client and all in-process state. */
export function __setRecorderClientForTests(c: Redis | null): void {
  _redis = c;
}
export function __resetRecorderStateForTests(): void {
  sessions.clear();
  localSteps.clear();
  localTabs.clear();
  _sessionLoads.clear();
  _redis = null;
}

function metaOf(s: RecorderSession): RecorderMeta {
  const { ws: _ws, ...meta } = s;
  void _ws;
  return meta;
}

/** Read session meta: memory hit returns directly (same-replica hot path); on miss, fall back to redis and hydrate into the in-memory cache.
 *  No redis → pure in-memory (single container/dev/tests). */
const _sessionLoads = new Map<string, Promise<RecorderSession | undefined>>();

export async function getSession(id: string): Promise<RecorderSession | undefined> {
  const cached = sessions.get(id);
  if (cached) return cached;
  const r = getRedisIfReady();
  if (!r) return undefined;
  // single-flight: concurrent first cold misses share one Promise, avoiding two hydrates producing different object references.
  const inflight = _sessionLoads.get(id);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      const raw = await r.get(`${SESSION_PREFIX}${id}`);
      if (!raw) return undefined;
      return hydrateMeta(JSON.parse(raw) as RecorderMeta);
    } catch (e) {
      logger.warn({ err: e, sessionId: id }, 'recorder session redis read failed');
      return sessions.get(id);
    } finally {
      _sessionLoads.delete(id);
    }
  })();
  _sessionLoads.set(id, p);
  return p;
}

function hydrateMeta(meta: RecorderMeta): RecorderSession {
  const s: RecorderSession = {
    sessionId: meta.sessionId,
    caseId: meta.caseId,
    mode: meta.mode ?? 'fresh',
    incognito: meta.incognito ?? false,
    resumeFromOrder: meta.resumeFromOrder,
    targetUrl: meta.targetUrl ?? null,
    dbSessionId: meta.dbSessionId,
  };
  sessions.set(s.sessionId, s); // hydrate: after the WS lands on this replica, message handling hits memory directly
  return s;
}

/** meta write-back (write-through): called after meta changes such as dbSessionId backfill. steps/tabs are not here —
 *  they go through append-style appendStep/appendTabEvent; whole-package write-back is precisely the old implementation's cross-replica overwrite defect. No redis → no-op. */
export async function persistSession(s: RecorderSession): Promise<void> {
  const r = getRedisIfReady();
  if (!r) return;
  try {
    await r.set(`${SESSION_PREFIX}${s.sessionId}`, JSON.stringify(metaOf(s)), 'EX', SESSION_TTL_S);
  } catch (e) {
    logger.warn({ err: e, sessionId: s.sessionId }, 'recorder session redis write failed');
  }
}

/** Append one step (RPUSH rather than whole-package overwrite, coexisting across replicas); also renews all three keys' TTLs so an active recording doesn't expire mid-flight. */
export async function appendStep(id: string, step: unknown): Promise<void> {
  const r = getRedisIfReady();
  if (!r) {
    const arr = localSteps.get(id) ?? [];
    localSteps.set(id, arr);
    arr.push(step);
    return;
  }
  try {
    await r.pipeline()
      .rpush(`${STEPS_PREFIX}${id}`, JSON.stringify(step))
      .pexpire(`${SESSION_PREFIX}${id}`, SESSION_TTL_S * 1000)
      .pexpire(`${STEPS_PREFIX}${id}`, SESSION_TTL_S * 1000)
      .pexpire(`${TABS_PREFIX}${id}`, SESSION_TTL_S * 1000)
      .exec();
  } catch (e) {
    logger.warn({ err: e, sessionId: id }, 'recorder step append failed');
  }
}

export async function appendTabEvent(id: string, ev: RecorderTabEvent): Promise<void> {
  const r = getRedisIfReady();
  if (!r) {
    const arr = localTabs.get(id) ?? [];
    localTabs.set(id, arr);
    arr.push(ev);
    return;
  }
  try {
    await r.pipeline()
      .rpush(`${TABS_PREFIX}${id}`, JSON.stringify(ev))
      .pexpire(`${SESSION_PREFIX}${id}`, SESSION_TTL_S * 1000)
      .pexpire(`${STEPS_PREFIX}${id}`, SESSION_TTL_S * 1000)
      .pexpire(`${TABS_PREFIX}${id}`, SESSION_TTL_S * 1000)
      .exec();
  } catch (e) {
    logger.warn({ err: e, sessionId: id }, 'recorder tab event append failed');
  }
}

async function readList<T>(prefix: string, id: string, local: Map<string, T[]>): Promise<T[]> {
  const r = getRedisIfReady();
  if (!r) return local.get(id) ?? [];
  try {
    return (await r.lrange(`${prefix}${id}`, 0, -1)).map((s) => JSON.parse(s) as T);
  } catch (e) {
    logger.warn({ err: e, sessionId: id }, 'recorder list read failed');
    return [];
  }
}

export function getSessionSteps(id: string): Promise<unknown[]> {
  return readList(STEPS_PREFIX, id, localSteps);
}

export function getSessionTabs(id: string): Promise<RecorderTabEvent[]> {
  return readList(TABS_PREFIX, id, localTabs);
}

export interface FinishedSession {
  meta: RecorderSession;
  steps: unknown[];
  tabs: RecorderTabEvent[];
}

/** Terminal read: fetch meta + steps + tabs in one shot and delete all keys (including in-process caches). A second finish → undefined
 *  (the route layer turns it into 404, blocking the old implementation's duplicate step insertion). meta prefers this replica's cached object — keeping the ws handle for the route's final close. */
export async function finishSession(id: string): Promise<FinishedSession | undefined> {
  const r = getRedisIfReady();
  const local = sessions.get(id);
  const dropLocal = (): void => {
    sessions.delete(id);
    localSteps.delete(id);
    localTabs.delete(id);
  };
  if (!r) {
    if (!local) return undefined;
    const steps = localSteps.get(id) ?? [];
    const tabs = localTabs.get(id) ?? [];
    dropLocal();
    return { meta: local, steps, tabs };
  }
  try {
    const raw = await r.get(`${SESSION_PREFIX}${id}`);
    if (!raw) {
      dropLocal();
      return undefined;
    }
    const pipeResult = (await r.pipeline()
      .lrange(`${STEPS_PREFIX}${id}`, 0, -1)
      .lrange(`${TABS_PREFIX}${id}`, 0, -1)
      .exec()) as Array<[Error | null, string[] | null] | null>;
    const steps = (pipeResult[0]?.[1] ?? []).map((s) => JSON.parse(s) as unknown);
    const tabs = (pipeResult[1]?.[1] ?? []).map((s) => JSON.parse(s) as RecorderTabEvent);
    await r.del(`${SESSION_PREFIX}${id}`, `${STEPS_PREFIX}${id}`, `${TABS_PREFIX}${id}`).catch(() => undefined);
    dropLocal();
    return { meta: local ?? hydrateMeta(JSON.parse(raw) as RecorderMeta), steps, tabs };
  } catch (e) {
    logger.warn({ err: e, sessionId: id }, 'recorder session finish read failed');
    return undefined;
  }
}

export function attachRecorderWs(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname !== '/recorder') return;
    const sessionId = url.searchParams.get('sessionId');
    const token = url.searchParams.get('token');
    if (!sessionId || !token || token !== secret) {
      socket.destroy();
      return;
    }
    void (async () => {
      // createSession's redis write is async; the WS may be routed by nginx to another replica — brief retries avoid "created then instantly destroyed".
      let session: RecorderSession | undefined;
      for (let i = 0; i < 3 && !session; i++) {
        session = await getSession(sessionId);
        if (!session && i < 2) await new Promise((r) => setTimeout(r, 100));
      }
      if (!session) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        session.ws = ws;
        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'step') {
              void appendStep(sessionId, msg.step);
            } else if (msg.type === 'tab-event') {
              void appendTabEvent(sessionId, msg.event);
            } else if (msg.type === 'finish') {
              ws.close(1000);
            }
          } catch {
            // ignore malformed
          }
        });
        ws.on('close', () => {
          if (session.ws === ws) session.ws = undefined;
        });
      });
    })();
  });
}

export function createSession(
  caseId: string,
  opts: { mode?: 'fresh' | 'append' | 'resume' | 'incognito'; incognito?: boolean; resumeFromOrder?: number; targetUrl?: string | null } = {},
): RecorderSession {
  const session: RecorderSession = {
    sessionId: crypto.randomUUID(),
    caseId,
    mode: opts.mode ?? 'fresh',
    incognito: opts.incognito ?? false,
    resumeFromOrder: opts.resumeFromOrder,
    targetUrl: opts.targetUrl ?? null,
  };
  sessions.set(session.sessionId, session);
  void persistSession(session);
  return session;
}
