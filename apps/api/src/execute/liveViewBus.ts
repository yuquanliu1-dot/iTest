/**
 * live view 跨副本桥（Redis）：多 api 副本 + nginx 轮询下，执行 job 落在某一副本，
 * 帧源/录制/心跳都只在该副本进程内存；其余副本的 /live 请求会 404（前端据此隐藏画面卡）。
 * 本模块把帧流（PUBLISH）、录制（LIST + TTL）、源活跃心跳（SET PX）搬上 Redis：
 * - 源副本：fanout/record/tick/teardown 顺手发布（全部 fire-and-forget，Redis 抖动不阻塞帧泵）；
 * - 其他副本：handleLive* 在本地无源时按心跳/录制键回退成「镜像」（subscribeMirror 收帧转发）。
 * 无 REDIS_URL（本地 dev / vitest）时全部 no-op，行为与单进程版完全一致。
 *
 * 信封（单帧单消息二进制）：[type:1B][ts:8B float64BE][jpeg bytes]；0x01=帧、0x02=结束。
 * 与 planRunBus 不同：镜像订阅只在「本地无源」时建立，本地路径不经 Redis 回环，无需 origin 去重。
 */
import IORedis, { type Redis } from 'ioredis';

/** 每份录制帧数上限（与 liveView 的录制有界一致；镜上回放最多看到这么多帧）。 */
export const MAX_REC_FRAMES = 1200;
/** 录制保留时长（ms）：teardown 后自此刻起过期；appendRecording 滚动续期（执行器崩溃也能自清）。 */
export const REC_TTL_MS = 30 * 60_000;
/** 源心跳 TTL（ms）：帧泵死亡 10s 内新镜像连接即 404。 */
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
/** key → 本副本上的镜像连接回调集（share 一条 SUBSCRIBE 连接，末个离开才退订频道）。 */
const _handlers = new Map<string, Set<{ onFrame: (ts: number, jpeg: Buffer) => void; onEnd: () => void }>>();
const _subscribed = new Set<string>();

/** 桥是否启用（无 REDIS_URL 时 liveView 的 fallback 全部走同步 no-op 路径）。 */
export function redisReady(): boolean {
  return !!process.env.REDIS_URL;
}

/** 发布/读共用一条普通连接（订阅模式连接不能跑 LRANGE 等命令）。 */
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
    // 帧是二进制信封，必须走 messageBuffer（message 事件会按 utf8 解码破坏 jpeg 字节）
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

// ── 源侧（执行副本发布，全部 fire-and-forget）─────────────────────────────────

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

/** 录制追加（有界 + 滚动 TTL：末帧后 30min 自清）。 */
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

/** teardown：录制 TTL 从结束时刻起算（覆盖运行中的滚动续期）。 */
export function expireRecording(key: string): void {
  void getPub()?.pexpire(`${REC_PREFIX}${key}`, REC_TTL_MS).catch(() => undefined);
}

/** 同 key 重注册：清掉上一轮录制，避免新旧混流。 */
export function clearRecording(key: string): void {
  void getPub()?.del(`${REC_PREFIX}${key}`).catch(() => undefined);
}

// ── 观看者回写（跨副本降档治理）───────────────────────────────────────────────

/** 观看者计数 TTL：镜像流断开方 DECR；崩溃残留靠 TTL 自清（期间源多出几档帧率，无害）。 */
export const VIEWERS_TTL_MS = 15_000;

/** 镜像流建立：计数 +1 并起 TTL。 */
export function viewersIncr(key: string): void {
  const r = getPub();
  if (!r) return;
  const vk = `${VIEWERS_PREFIX}${key}`;
  void r.pipeline().incr(vk).pexpire(vk, VIEWERS_TTL_MS).exec().catch(() => undefined);
}

/** 镜像流断开：计数 -1（崩溃残留可能已过期 → 可为负，读取端钳 0）。 */
export function viewersDecr(key: string): void {
  void getPub()?.decr(`${VIEWERS_PREFIX}${key}`).catch(() => undefined);
}

/** 镜像流保活：长静默（无帧转发）时续 TTL，防计数先行过期、源端误判无人观看。 */
export function viewersTouch(key: string): void {
  void getPub()?.pexpire(`${VIEWERS_PREFIX}${key}`, VIEWERS_TTL_MS).catch(() => undefined);
}

/** 源侧读取（tick 每拍一次）：无 Redis/无键/错误 → 0。 */
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

// ── 镜像侧（非执行副本读取/订阅）─────────────────────────────────────────────

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

/** 远端录制可用性（不拉全量：LLEN + 首末帧 + PTTL）。无录制/无 Redis → null。 */
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

/** 镜像订阅：本地无源的副本借 Redis 收帧转发给本机 HTTP 订阅者。返回退订函数（幂等）。 */
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
