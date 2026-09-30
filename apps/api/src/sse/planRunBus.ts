import type { Response } from 'express';

export interface PlanRunEvent {
  type: string;
  caseId?: string;
  stepKind?: 'login_prepare' | 'business';
  status?: string;
  reportId?: string;
  summary?: string;
}

const subscribers = new Map<string, Set<Response>>();

export function subscribeRunEvent(runId: string, res: Response): () => void {
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

export function publishRunEvent(runId: string, event: PlanRunEvent): void {
  const set = subscribers.get(runId);
  if (!set) return;
  for (const res of set) {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      /* peer closed */
    }
  }
}

export function subscriberCount(runId: string): number {
  return subscribers.get(runId)?.size ?? 0;
}