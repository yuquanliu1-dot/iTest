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
 * 可序列化会话元数据（不含 steps/tabs/ws）。steps/tabs 走追加式存储（Redis LIST），meta 才是
 * 被缓存/跨副本共享的对象——旧实现的「整记录缓存」会在 B 副本 persistSession 时用 hydrate 出的
 * 旧 steps 数组整包覆盖 Redis（录制 REST 与 WS 本就常落不同副本 → 静默丢步骤）。
 */
export interface RecorderMeta {
  sessionId: string;
  caseId: string;
  mode?: 'fresh' | 'append' | 'resume' | 'incognito';
  incognito?: boolean;
  resumeFromOrder?: number;
  /** web 中台启动录制时传入的目标 URL；finish() 用作 test_cases.url 的来源之一。 */
  targetUrl?: string | null;
  /** test_sessions audit row id, set by the route that persisted it. */
  dbSessionId?: string;
}

/** 进程内视图 = meta + 本副本 WS 句柄（ws 不序列化；finish 落在其他副本时拿不到，现状语义）。 */
export interface RecorderSession extends RecorderMeta {
  ws?: WebSocket;
}

const sessions = new Map<string, RecorderSession>();
/** 无 Redis（单容器/dev/测试）时的 steps/tabs 兜底：与 Redis 版同构的追加语义。 */
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

/** 测试缝（仿 cache.ts）：注入/清除 Redis 客户端与全部进程内状态。 */
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

/** 读会话 meta：内存命中直接返回（同 replica 热路径）；miss 时回落 redis 并 hydrate 进内存缓存。
 *  无 redis → 纯内存（单容器/dev/测试）。 */
const _sessionLoads = new Map<string, Promise<RecorderSession | undefined>>();

export async function getSession(id: string): Promise<RecorderSession | undefined> {
  const cached = sessions.get(id);
  if (cached) return cached;
  const r = getRedisIfReady();
  if (!r) return undefined;
  // single-flight：并发的首次 cold miss 共享同一 Promise,避免两次 hydrate 出不同对象引用。
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
  sessions.set(s.sessionId, s); // hydrate:WS 落本 replica 后消息处理直接命中内存
  return s;
}

/** meta 写回（write-through）：dbSessionId 回填等 meta 变更后调用。steps/tabs 不在这里——
 *  它们走追加式 appendStep/appendTabEvent，整包写回正是旧实现的跨副本覆盖缺陷。无 redis → no-op。 */
export async function persistSession(s: RecorderSession): Promise<void> {
  const r = getRedisIfReady();
  if (!r) return;
  try {
    await r.set(`${SESSION_PREFIX}${s.sessionId}`, JSON.stringify(metaOf(s)), 'EX', SESSION_TTL_S);
  } catch (e) {
    logger.warn({ err: e, sessionId: s.sessionId }, 'recorder session redis write failed');
  }
}

/** 追加一步（RPUSH 而非整包覆盖，跨副本并存）；顺手续期三键，活跃录制不中途过期。 */
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

/** 终局读取：meta + steps + tabs 一次取齐并删除全部键（含进程内缓存）。二次 finish → undefined
 *  （路由层转 404，杜绝旧实现的重复插步）。meta 优先取本副本缓存对象——保留 ws 句柄供路由收尾关闭。 */
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
      // createSession 的 redis 写是异步的;WS 可能被 nginx 路由到另一副本,短暂重试避免「新建即被销毁」。
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
