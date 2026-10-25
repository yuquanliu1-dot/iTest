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

// ── 线程事件 seq(全局单调) ──────────────────────────────────────────────────
// seq 曾是每副本内存计数器:三副本下各有一本账,副本重启/冷构建归零,SSE 快照信封带的
// 基线因此失真——react-pi 把「seq 更低的快照」当序列重置(lastSeq 打回 ~0),后续镜像
// message_start 无条件 append,用户消息在快照+事件里各一份 = 前端双气泡。seq 上移到
// Redis(每事件 INCR,串行泵内分配,见 session.ts)后基线全局单调,快照/GET 体带真实
// 高水位,react-pi 内建的旧事件门/快照重置检测/overtaken 保护全部生效。

export const THREAD_SEQ_PREFIX = 'itest:thread-seq:';
/** Redis 故障/无 Redis 时的进程内兜底计数(跨副本一致性丢失,单进程语义不变)。 */
const localSeqFallback = new Map<string, number>();

/** 分配下一个全局事件 seq。Redis 故障时退化为本地计数:已发出的高 seq 会让别的副本
 *  事件在前端被旧事件门暂时挡住,直到下一次快照重建基线,属可自愈降级。 */
export async function allocateThreadSeq(threadId: string): Promise<number> {
  const r = getPub();
  if (r) {
    try {
      return await r.incr(`${THREAD_SEQ_PREFIX}${threadId}`);
    } catch { /* 落本地兜底 */ }
  }
  const next = (localSeqFallback.get(threadId) ?? 0) + 1;
  localSeqFallback.set(threadId, next);
  return next;
}

/** 当前 seq 高水位(冷构建基线)。键不存在/无 Redis → 0。 */
export async function currentThreadSeq(threadId: string): Promise<number> {
  const r = getPub();
  if (r) {
    try {
      return Number(await r.get(`${THREAD_SEQ_PREFIX}${threadId}`)) || 0;
    } catch { /* 落本地兜底 */ }
  }
  return localSeqFallback.get(threadId) ?? 0;
}

/** 线程删除时清 seq 键(幂等)。id 不复用,仅为卫生;进程重启/Redis 重启不清——
 *  全局单调性正是要跨重启保住的状态。 */
export function deleteThreadSeq(threadId: string): void {
  localSeqFallback.delete(threadId);
  void getPub()?.del(`${THREAD_SEQ_PREFIX}${threadId}`).catch(() => undefined);
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
