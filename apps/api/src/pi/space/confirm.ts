/**
 * 人审挂起注册表(confirm gate)。
 * 敏感工具 action 在执行前调 requestConfirmation:向线程 SSE 订阅者广播 confirm_request,
 * 然后 await 用户在确认卡上的决定(POST /api/assistant/threads/:id/confirm)。
 * 对 LLM 就是一次"较慢的正常工具调用",不改动 pi 会话协议。
 * 挂起态仅存内存(上限 CONFIRM_TIMEOUT_MS):API 重启丢一个挂起轮次 = 该轮报错、用户重说,不建表。
 */
import { randomUUID } from 'node:crypto';

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
      resolve(false);
    }, CONFIRM_TIMEOUT_MS);
    pending.set(confirmId, {
      resolve: (approved) => {
        clearTimeout(timer);
        resolve(approved);
      },
      timer,
      payload,
    });
    emit(payload);
  });
}

/** 落确认结果;confirmId 不存在(已超时/已处理/伪造)返回 false。 */
export function resolveConfirmation(confirmId: string, approved: boolean): boolean {
  const entry = pending.get(confirmId);
  if (!entry) return false;
  pending.delete(confirmId);
  entry.resolve(approved);
  return true;
}

/** 挂起中的确认卡事件体列表(供 SSE 重连重放);只含仍挂起的卡,超时/已处理自动不在列。 */
export function pendingConfirmPayloads(): Array<Record<string, unknown>> {
  return [...pending.values()].map((e) => e.payload);
}

export function pendingCountForTesting(): number {
  return pending.size;
}
