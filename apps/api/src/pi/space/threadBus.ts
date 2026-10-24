/**
 * Assistant/RCA 线程跨副本桥(Redis):3 副本 + nginx 轮询下,线程 session 常驻某一副本
 * 进程内存,其余副本看不到运行态、收不到事件、cancel 打空。本模块把三件事搬上 Redis:
 * - 事件镜像:session.ts 的 fanOut/emitThreadEvent 顺手 PUBLISH(信封 {o,e});SSE 路由经
 *   subscribeThreadMirror 收「他副本」事件透传进同一响应(origin 相同的本副本回环跳过,
 *   本地 listeners 已送达过,重复透传会让前端 seq 去重器看到双份)。
 * - cancel 命令:PSUBSCRIBE itest:thread-cmd:* → 本地有该线程 record 即 abort。处理函数由
 *   session.ts 注入(避免 threadBus ↔ session 模块环);cancelThread 本地快路径 + 始终 PUBLISH。
 * - 运行态探测:itest:thread-run 锁键由 session.ts 经 redisLock 维护(runs>0 期间 5s 心跳续期),
 *   threadRunRemote 用 EXISTS 探测,供 threadStatusAsync 把他副本运行中的线程标成 running。
 * 无 REDIS_URL(本地 dev / vitest)时全部 no-op,行为与单进程版完全一致。
 */
import IORedis, { type Redis } from 'ioredis';
import { ORIGIN_ID } from '../../lib/redisLock.js';

export const THREAD_EV_PREFIX = 'itest:thread-ev:';
export const THREAD_CMD_PREFIX = 'itest:thread-cmd:';
const THREAD_CMD_PATTERN = `${THREAD_CMD_PREFIX}*`;
/** 运行锁键前缀(值=持有副本的 ORIGIN_ID;键的 TTL/心跳在 session.ts)。 */
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

// ── 事件镜像 ─────────────────────────────────────────────────────────────────

/** threadId → 本副本上的 SSE 转发回调集(share 一条 SUBSCRIBE 连接,末个离开才退订)。 */
const _evHandlers = new Map<string, Set<(e: unknown) => void>>();
const _evSubscribed = new Set<string>();

/** 源侧:线程事件发布(fire-and-forget;stamped 已带 threadId+seq,前端按 seq 去重)。 */
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
  if (env.o === ORIGIN_ID) return; // 本副本回环:本地 listeners 已送达
  for (const fn of set) {
    try { fn(env.e); } catch { /* 单个订阅者异常不拖垮分发 */ }
  }
}

/** SSE 侧:订阅他副本镜像事件(异源转发给 fn,本副本回环跳过)。返回退订函数(幂等)。 */
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

// ── cancel 命令 ──────────────────────────────────────────────────────────────

/** 源侧:广播 cancel 命令(值=发起副本 ORIGIN_ID,供各副本过滤自己的回环)。 */
export function publishThreadCancel(threadId: string): void {
  void getPub()?.publish(`${THREAD_CMD_PREFIX}${threadId}`, ORIGIN_ID).catch(() => undefined);
}

function dispatchCommand(threadId: string, msg: string): void {
  if (msg === ORIGIN_ID) return; // 本副本 cancelThread 已走本地快路径 abort
  _cancelHandler?.(threadId);
}

/** 注册本地 abort 处理并(一次性)PSUBSCRIBE 命令频道;无 Redis 时仅注册不订阅。
 *  session.ts 模块加载时调用;重复调用只更新处理函数,不重复订阅。 */
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

// ── 运行态探测 ───────────────────────────────────────────────────────────────

/** 他副本是否正持有该线程的运行锁。无 Redis/错误 → false(退化为本地视角)。 */
export async function threadRunRemote(threadId: string): Promise<boolean> {
  const r = getPub();
  if (!r) return false;
  try {
    return (await r.exists(`${THREAD_RUN_PREFIX}${threadId}`)) > 0;
  } catch {
    return false;
  }
}
