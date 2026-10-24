/**
 * 人审挂起注册表(confirm gate)。
 * 敏感工具 action 在执行前调 requestConfirmation:向线程 SSE 订阅者广播 confirm_request,
 * 然后 await 用户在确认卡上的决定(POST /api/assistant/threads/:id/confirm)。
 * 对 LLM 就是一次"较慢的正常工具调用",不改动 pi 会话协议。
 * 挂起态仅存内存(上限 CONFIRM_TIMEOUT_MS):API 重启丢一个挂起轮次 = 该轮报错、用户重说,不建表。
 * 跨副本:工具常驻运行副本,用户的 confirm POST 可能落在另一副本——挂起时把事件体 SET 到
 * Redis(认领键)+ 订阅答案频道;他副本 resolveConfirmation 走 GETDEL 原子认领 + PUBLISH 答案
 * 回挂起副本。无 REDIS_URL(本地 dev / vitest)时不建门,行为与单进程版逐字节一致。
 */
import { randomUUID } from 'node:crypto';
import IORedis, { type Redis } from 'ioredis';

export type ConfirmRisk = 'update' | 'delete' | 'secret';

export interface ConfirmRequestInput {
  threadId: string;
  toolName: string;
  action: string;
  /** 确认卡主文案,如「删除用例「登录-正常」」;密钥类不得含明文值。 */
  summary: string;
  /** 人类可读 diff 文本(update 类);缺省无。 */
  diff?: string;
  risk: ConfirmRisk;
}

type Resolver = (approved: boolean) => void;

interface PendingEntry {
  resolve: Resolver;
  timer: NodeJS.Timeout;
  /** confirm_request 事件体快照:SSE 断线重连时只重放仍挂起的确认卡(session.ts 的
   *  subscribeThread 读取),已处理/已超时的卡随 pending 删除自动从重放源消失,不会复活。 */
  payload: Record<string, unknown>;
}

export const CONFIRM_TIMEOUT_MS = 5 * 60_000;

const pending = new Map<string, PendingEntry>();

// ── 跨副本门(Redis)──────────────────────────────────────────────────────────
// 认领键 itest:confirm:<confirmId> = 事件体 JSON(PX = 挂起超时,超时自清);
// 答案频道 itest:confirm-res:<confirmId> 消息 '1'/'0'。GETDEL 保证恰好一个副本认领。

const KEY_PREFIX = 'itest:confirm:';
const RES_PREFIX = 'itest:confirm-res:';

let _pub: Redis | null = null;
let _sub: Redis | null = null;
/** confirmId → 本地收尾(等价 entry.resolve + 清理):答案频道消息派发用。 */
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

/** 挂起时打开跨副本门:写认领键 + 订阅答案频道。订阅失败只损失跨副本确认(本副本路径不受影响),
 *  认领键写失败则他副本 GETDEL miss → confirm 404,挂起副本超时兜底。 */
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

/** 收尾跨副本门:退订 + 删认领键。三条路径(本地 resolve/超时/答案到达)都走——
 *  本地 resolve 后删键尤为必要:晚到的重复点击不该还能认领一扇已关的门。 */
function closeRedisGate(confirmId: string): void {
  _waiters.delete(confirmId);
  if (_subscribed.delete(confirmId)) {
    void _sub?.unsubscribe(`${RES_PREFIX}${confirmId}`).catch(() => undefined);
  }
  void _pub?.del(`${KEY_PREFIX}${confirmId}`).catch(() => undefined);
}

/**
 * 发起一次确认并挂起。emit 负责把 confirm_request 事件扇出到线程 SSE
 * (session.ts 的 emitThreadEvent);事件体自动带 confirmId。emit 不得抛异常
 * (emitThreadEvent 对无订阅者静默丢弃,天然满足)——抛出会留下悬空挂起项。
 * 超时/取消一律 resolve(false),调用方把它当 { ok:false, error:'用户取消了该操作' } 返回给 LLM。
 */
export function requestConfirmation(req: ConfirmRequestInput, emit: (e: Record<string, unknown>) => void): Promise<boolean> {
  const confirmId = randomUUID();
  // 事件体一次构造:emit(直播)与 pending.payload(重连重放)共用同一份,保证两路一致
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

/** 落确认结果;confirmId 不存在(已超时/已处理/伪造)返回 false。本地无挂起时探跨副本门:
 *  GETDEL 原子认领 → 命中则 PUBLISH 答案回挂起副本(重复点击/并发认领只有一个生效)。 */
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

/** 挂起中的确认卡事件体列表(供 SSE 重连重放);只含仍挂起的卡,超时/已处理自动不在列。
 *  已知缺口(接受):只读本副本挂起——跨副本挂起(RCA 线程)在 SSE 断线重连瞬间丢卡,
 *  实时答案/事件镜像仍会送达后续状态。 */
export function pendingConfirmPayloads(): Array<Record<string, unknown>> {
  return [...pending.values()].map((e) => e.payload);
}

export function pendingCountForTesting(): number {
  return pending.size;
}
