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

export interface RecorderSession {
  sessionId: string;
  caseId: string;
  steps: unknown[];
  ws?: WebSocket;
  mode?: 'fresh' | 'append' | 'resume' | 'incognito';
  incognito?: boolean;
  resumeFromOrder?: number;
  tabs?: RecorderTabEvent[];
  /** web 中台启动录制时传入的目标 URL；finish() 用作 test_cases.url 的来源之一。 */
  targetUrl?: string | null;
  /** test_sessions audit row id, set by the route that persisted it. */
  dbSessionId?: string;
}

const sessions = new Map<string, RecorderSession>();
const secret = process.env.RECORDER_TOKEN_SECRET ?? 'dev-secret-change-me';
const SESSION_TTL = 3600;
const SESSION_PREFIX = 'itest:rec:';

let _redis: Redis | null = null;
function getRedisIfReady(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  if (!_redis) {
    _redis = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
    _redis.on('error', () => undefined);
  }
  return _redis;
}

/** 可序列化会话核心（不含 ws）。 */
function sessionToRecord(s: RecorderSession): Omit<RecorderSession, 'ws'> {
  const { ws: _ws, ...rest } = s;
  void _ws;
  return rest;
}

/** 读会话：内存命中直接返回（同 replica 热路径）；miss 时回落 redis 并 hydrate 进内存缓存。
 *  无 redis → 纯内存（单容器/dev/测试）。 */
const _sessionLoads = new Map<string, Promise<RecorderSession | undefined>>();

export async function getSession(id: string): Promise<RecorderSession | undefined> {
  const cached = sessions.get(id);
  if (cached) return cached;
  const r = getRedisIfReady();
  if (!r) return undefined;
  // single-flight：并发的首次 cold miss 共享同一 Promise,避免两次 hydrate 出不同对象引用
  // （WS upgrade 与 finish/tab-events 各拿一个对象会互相丢 steps）。
  const inflight = _sessionLoads.get(id);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      const raw = await r.get(`${SESSION_PREFIX}${id}`);
      if (!raw) return undefined;
      const rec = JSON.parse(raw) as ReturnType<typeof sessionToRecord>;
      const s: RecorderSession = {
        sessionId: rec.sessionId,
        caseId: rec.caseId,
        steps: rec.steps ?? [],
        mode: rec.mode ?? 'fresh',
        incognito: rec.incognito ?? false,
        resumeFromOrder: rec.resumeFromOrder,
        tabs: rec.tabs ?? [],
        targetUrl: rec.targetUrl ?? null,
        dbSessionId: rec.dbSessionId,
      };
      sessions.set(s.sessionId, s); // hydrate:WS 落本 replica 后 steps 推送直接命中内存
      return s;
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

/** 会话写回（write-through）：内存对象已更新后调用,持久化给其他 replica。无 redis → no-op。 */
export async function persistSession(s: RecorderSession): Promise<void> {
  const r = getRedisIfReady();
  if (!r) return;
  try {
    await r.set(`${SESSION_PREFIX}${s.sessionId}`, JSON.stringify(sessionToRecord(s)), 'EX', SESSION_TTL);
  } catch (e) {
    logger.warn({ err: e, sessionId: s.sessionId }, 'recorder session redis write failed');
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
              session.steps.push(msg.step);
              void persistSession(session);
            } else if (msg.type === 'tab-event' && session.tabs) {
              session.tabs.push(msg.event);
              void persistSession(session);
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
    steps: [],
    mode: opts.mode ?? 'fresh',
    incognito: opts.incognito ?? false,
    resumeFromOrder: opts.resumeFromOrder,
    tabs: [],
    targetUrl: opts.targetUrl ?? null,
  };
  sessions.set(session.sessionId, session);
  void persistSession(session);
  return session;
}
