import IORedis, { type Redis } from 'ioredis';
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
const PREFIX = 'itest:sse:';
/** Per-process unique origin: lets cross-container consumers tell whether "this event is my own", preventing local-direct-write + redis-loopback double writes. */
const ORIGIN_ID = crypto.randomUUID();

let _pub: Redis | null = null;
let _sub: Redis | null = null;
const _subscribed = new Set<string>();

function redisReady(): boolean {
  return !!process.env.REDIS_URL;
}

function getPub(): Redis | null {
  if (!redisReady()) return null;
  if (!_pub) {
    _pub = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    _pub.on('error', () => undefined);
  }
  return _pub;
}

function getSub(): Redis | null {
  if (!redisReady()) return null;
  if (!_sub) {
    _sub = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    _sub.on('error', () => undefined);
    _sub.on('message', (channel, payload) => {
      if (!channel.startsWith(PREFIX)) return;
      const runId = channel.slice(PREFIX.length);
      const set = subscribers.get(runId);
      if (!set) return;
      let parsed: { o?: string; e?: PlanRunEvent };
      try {
        parsed = JSON.parse(payload);
      } catch {
        return;
      }
      if (parsed.o === ORIGIN_ID) return; // this container already wrote locally, skip the loopback
      const evt = parsed.e;
      if (!evt) return;
      for (const res of set) {
        try {
          res.write(`data: ${JSON.stringify(evt)}\n\n`);
        } catch {
          /* peer closed */
        }
      }
    });
  }
  return _sub;
}

export function subscribeRunEvent(runId: string, res: Response): () => void {
  const prev = subscribers.get(runId);
  const first = !prev || prev.size === 0;
  if (!prev) subscribers.set(runId, new Set());
  subscribers.get(runId)!.add(res);
  if (first) subscribeChannel(runId);
  return () => {
    const cur = subscribers.get(runId);
    if (!cur) return;
    cur.delete(res);
    if (cur.size === 0) {
      subscribers.delete(runId);
      unsubscribeChannel(runId);
    }
  };
}

function subscribeChannel(runId: string): void {
  const sub = getSub();
  if (!sub || _subscribed.has(runId)) return;
  _subscribed.add(runId);
  void sub.subscribe(`${PREFIX}${runId}`).catch(() => {
    _subscribed.delete(runId);
  });
}

function unsubscribeChannel(runId: string): void {
  const sub = getSub();
  if (!sub) return;
  _subscribed.delete(runId);
  void sub.unsubscribe(`${PREFIX}${runId}`).catch(() => undefined);
}

export function publishRunEvent(runId: string, event: PlanRunEvent): void {
  // Write locally first (zero latency for same-container subscribers, no loopback dependency); then PUBLISH cross-container, deduped by origin.
  const set = subscribers.get(runId);
  if (set) {
    for (const res of set) {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        /* peer closed */
      }
    }
  }
  if (redisReady()) {
    void getPub()?.publish(`${PREFIX}${runId}`, JSON.stringify({ o: ORIGIN_ID, e: event })).catch(() => undefined);
  }
}

export function subscriberCount(runId: string): number {
  return subscribers.get(runId)?.size ?? 0;
}