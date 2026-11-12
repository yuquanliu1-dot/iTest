/**
 * live view cross-replica bridge (Redis): with multiple api replicas + nginx round-robin, the execution job lands on one replica,
 * and the frame source/recording/heartbeat live only in that replica's process memory; other replicas' /live requests would 404 (the frontend hides the picture card accordingly).
 * This module lifts the frame stream (PUBLISH), recordings (LIST + TTL), and source-alive heartbeats (SET PX) onto Redis:
 * - Source replica: fanout/record/tick/teardown publish in passing (all fire-and-forget; Redis jitter never blocks the frame pump);
 * - Other replicas: handleLive* falls back to a "mirror" keyed on the heartbeat/recording keys when there's no local source (subscribeMirror receives frames and forwards).
 * Without REDIS_URL (local dev / vitest) everything is no-op, behavior identical to the single-process version.
 *
 * Envelope (one frame per message, binary): [type:1B][ts:8B float64BE][jpeg bytes]; 0x01=frame, 0x02=end.
 * Unlike planRunBus: the mirror subscription is established only when there's no local source; the local path never loops through Redis, so no origin dedup is needed.
 */
import IORedis, { type Redis } from 'ioredis';

/** Per-recording frame cap (matches liveView's bounded recording; a bridge replay shows at most this many frames). */
export const MAX_REC_FRAMES = 1200;
/** Recording retention (ms): expires from the teardown moment; appendRecording rolls the TTL forward (self-cleans even if the executor crashes). */
export const REC_TTL_MS = 30 * 60_000;
/** Source heartbeat TTL (ms): new mirror connections get a 404 within 10s of the frame pump dying. */
const HEARTBEAT_TTL_MS = 10_000;

export const EV_FRAME = 0x01;
export const EV_END = 0x02;

const CH_PREFIX = 'itest:live:';
const ACTIVE_PREFIX = 'itest:live-active:';
const REC_PREFIX = 'itest:live-rec:';
const VIEWERS_PREFIX = 'itest:live-viewers:';

export interface LiveEvent {
  type: number;
  ts: number;
  payload: Buffer;
}

export function encodeEvent(type: number, ts: number, payload?: Buffer): Buffer {
  const head = Buffer.alloc(9);
  head.writeUInt8(type, 0);
  head.writeDoubleBE(ts, 1);
  return payload && payload.length > 0 ? Buffer.concat([head, payload]) : head;
}

export function decodeEvent(buf: Buffer): LiveEvent | null {
  if (!buf || buf.length < 9) return null;
  const type = buf.readUInt8(0);
  if (type !== EV_FRAME && type !== EV_END) return null;
  return { type, ts: buf.readDoubleBE(1), payload: buf.subarray(9) };
}

let _pub: Redis | null = null;
let _sub: Redis | null = null;
/** key → set of mirror-connection callbacks on this replica (shares one SUBSCRIBE connection; the channel is unsubscribed only when the last one leaves). */
const _handlers = new Map<string, Set<{ onFrame: (ts: number, jpeg: Buffer) => void; onEnd: () => void }>>();
const _subscribed = new Set<string>();

/** Whether the bridge is enabled (without REDIS_URL, liveView's fallbacks all take the synchronous no-op path). */
export function redisReady(): boolean {
  return !!process.env.REDIS_URL;
}

/** Publish/read share one ordinary connection (a subscription-mode connection can't run commands like LRANGE). */
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
    // Frames are binary envelopes; must use messageBuffer (the message event decodes as utf8, corrupting the jpeg bytes)
    _sub.on('messageBuffer', (chan: Buffer, msg: Buffer) => {
      const channel = chan.toString();
      if (!channel.startsWith(CH_PREFIX)) return;
      const set = _handlers.get(channel.slice(CH_PREFIX.length));
      if (!set || set.size === 0) return;
      const ev = decodeEvent(msg);
      if (!ev) return;
      if (ev.type === EV_END) {
        for (const h of set) h.onEnd();
        return;
      }
      if (ev.payload.length > 0) {
        for (const h of set) h.onFrame(ev.ts, ev.payload);
      }
    });
  }
  return _sub;
}

// ── Source side (the executing replica publishes; all fire-and-forget) ──────

export function heartbeatSet(key: string): void {
  void getPub()?.set(`${ACTIVE_PREFIX}${key}`, '1', 'PX', HEARTBEAT_TTL_MS).catch(() => undefined);
}

export function heartbeatClear(key: string): void {
  void getPub()?.del(`${ACTIVE_PREFIX}${key}`).catch(() => undefined);
}

export function publishFrame(key: string, ts: number, jpeg: Buffer): void {
  void getPub()?.publish(`${CH_PREFIX}${key}`, encodeEvent(EV_FRAME, ts, jpeg)).catch(() => undefined);
}

export function publishEnd(key: string): void {
  void getPub()?.publish(`${CH_PREFIX}${key}`, encodeEvent(EV_END, Date.now())).catch(() => undefined);
}

/** Recording append (bounded + rolling TTL: self-cleans 30min after the last frame). */
export function appendRecording(key: string, ts: number, jpeg: Buffer): void {
  const r = getPub();
  if (!r) return;
  const recKey = `${REC_PREFIX}${key}`;
  void r
    .pipeline()
    .rpush(recKey, encodeEvent(EV_FRAME, ts, jpeg))
    .ltrim(recKey, -MAX_REC_FRAMES, -1)
    .pexpire(recKey, REC_TTL_MS)
    .exec()
    .catch(() => undefined);
}

/** teardown: the recording TTL starts from the finish moment (overriding the rolling renewal while running). */
export function expireRecording(key: string): void {
  void getPub()?.pexpire(`${REC_PREFIX}${key}`, REC_TTL_MS).catch(() => undefined);
}

/** Same-key re-registration: clears the previous run's recording so old and new don't mix. */
export function clearRecording(key: string): void {
  void getPub()?.del(`${REC_PREFIX}${key}`).catch(() => undefined);
}

// ── Viewer feedback (cross-replica downgrade governance) ────────────────────

/** Viewer-count TTL: the mirror stream's disconnect side DECRs; crash residue self-cleans via TTL (the source briefly runs a tier or two higher meanwhile — harmless). */
export const VIEWERS_TTL_MS = 15_000;

/** Mirror stream established: count +1 and start the TTL. */
export function viewersIncr(key: string): void {
  const r = getPub();
  if (!r) return;
  const vk = `${VIEWERS_PREFIX}${key}`;
  void r.pipeline().incr(vk).pexpire(vk, VIEWERS_TTL_MS).exec().catch(() => undefined);
}

/** Mirror stream disconnected: count -1 (crash residue may have expired → can go negative; readers clamp to 0). */
export function viewersDecr(key: string): void {
  void getPub()?.decr(`${VIEWERS_PREFIX}${key}`).catch(() => undefined);
}

/** Mirror stream keepalive: renews the TTL during long silences (no frame forwarding), preventing the count from expiring early and the source misjudging nobody-watching. */
export function viewersTouch(key: string): void {
  void getPub()?.pexpire(`${VIEWERS_PREFIX}${key}`, VIEWERS_TTL_MS).catch(() => undefined);
}

/** Source-side read (once per tick): no Redis / no key / error → 0. */
export async function viewersGet(key: string): Promise<number> {
  const r = getPub();
  if (!r) return 0;
  try {
    const n = await r.get(`${VIEWERS_PREFIX}${key}`);
    return Math.max(0, Number(n ?? 0));
  } catch {
    return 0;
  }
}

// ── Mirror side (non-executing replicas read/subscribe) ─────────────────────

export async function remoteSourceAlive(key: string): Promise<boolean> {
  const r = getPub();
  if (!r) return false;
  try {
    return (await r.exists(`${ACTIVE_PREFIX}${key}`)) > 0;
  } catch {
    return false;
  }
}

export interface RemoteRecordingInfo {
  frames: number;
  firstTs: number;
  lastTs: number;
  ttlMs: number;
}

/** Remote recording availability (no full pull: LLEN + first/last frame + PTTL). No recording / no Redis → null. */
export async function remoteRecordingInfo(key: string): Promise<RemoteRecordingInfo | null> {
  const r = getPub();
  if (!r) return null;
  const recKey = `${REC_PREFIX}${key}`;
  try {
    const frames = await r.llen(recKey);
    if (frames <= 0) return null;
    const [head, tail, ttlMs] = await Promise.all([
      r.lrangeBuffer(recKey, 0, 0),
      r.lrangeBuffer(recKey, -1, -1),
      r.pttl(recKey),
    ]);
    const firstTs = head.length > 0 ? (decodeEvent(head[0]!)?.ts ?? 0) : 0;
    const lastTs = tail.length > 0 ? (decodeEvent(tail[0]!)?.ts ?? firstTs) : firstTs;
    return { frames, firstTs, lastTs, ttlMs: Math.max(ttlMs, 0) };
  } catch {
    return null;
  }
}

export interface RecordedFrame {
  ts: number;
  data: Buffer;
}

export async function readRemoteRecording(key: string): Promise<RecordedFrame[]> {
  const r = getPub();
  if (!r) return [];
  try {
    const raw = await r.lrangeBuffer(`${REC_PREFIX}${key}`, 0, -1);
    const out: RecordedFrame[] = [];
    for (const buf of raw) {
      const ev = decodeEvent(buf);
      if (ev && ev.type === EV_FRAME && ev.payload.length > 0) out.push({ ts: ev.ts, data: ev.payload });
    }
    return out;
  } catch {
    return [];
  }
}

export interface MirrorHandlers {
  onFrame: (ts: number, jpeg: Buffer) => void;
  onEnd: () => void;
}

/** Mirror subscription: replicas without a local source receive frames via Redis and forward them to local HTTP subscribers. Returns an unsubscribe function (idempotent). */
export function subscribeMirror(key: string, h: MirrorHandlers): () => void {
  let set = _handlers.get(key);
  const first = !set || set.size === 0;
  if (!set) {
    set = new Set();
    _handlers.set(key, set);
  }
  const entry = { onFrame: h.onFrame, onEnd: h.onEnd };
  set.add(entry);
  if (first) {
    const sub = getSub();
    if (sub) {
      _subscribed.add(key);
      void sub.subscribe(`${CH_PREFIX}${key}`).catch(() => {
        _subscribed.delete(key);
      });
    }
  }
  return () => {
    const cur = _handlers.get(key);
    if (!cur || !cur.delete(entry)) return;
    if (cur.size === 0) {
      _handlers.delete(key);
      const sub = getSub();
      if (sub && _subscribed.delete(key)) {
        void sub.unsubscribe(`${CH_PREFIX}${key}`).catch(() => undefined);
      }
    }
  };
}
