import type { AgentEvent } from '../agent/agentFactory.js';
import { sseSend } from './agentRunStream.js';

/**
 * Per-run SSE 订阅者表：runId → Set<Response>。
 * executeRun 写发布，GET /:id/events 写订阅，关闭时双方清理。
 */
const subscribers = new Map<string, Set<import('express').Response>>();

export function subscribeRun(runId: string, res: import('express').Response): () => void {
  let set = subscribers.get(runId);
  if (!set) {
    set = new Set();
    subscribers.set(runId, set);
  }
  set.add(res);
  return () => {
    const cur = subscribers.get(runId);
    if (!cur) return;
    cur.delete(res);
    if (cur.size === 0) subscribers.delete(runId);
  };
}

export function publishRunEvent(runId: string, event: AgentEvent): void {
  const set = subscribers.get(runId);
  if (!set) return;
  for (const res of set) {
    try { sseSend(res, event); } catch { /* peer closed mid-write; cleanup on close */ }
  }
}

/** 调试用：返回 runId 的订阅者数量。 */
export function subscriberCount(runId: string): number {
  return subscribers.get(runId)?.size ?? 0;
}