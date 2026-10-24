/**
 * 实时画面（playground）：无头浏览器执行期间的 MJPEG 流（multipart/x-mixed-replace），
 * 前端 <img src> 原生解码。借鉴 Midscene playground 的分层：CDP screencast（repaint 驱动、
 * 可捕捉亚秒级动作/高亮）为主，轮询截图兜底（screencast 不可用/停滞/静默保活）。
 *
 * 多订阅 hub：每个画面源（liveKey）一份数据泵，N 个 HTTP 连接扇出同帧；无观看者时泵停转、
 * 零开销。key 两种形态：随机 UUID（verify/solidify 工具，key 即能力凭证）与稳定 key
 * （`planrun:<id>` / `case:<id>`，路由层做项目可见性鉴权后转发）。
 *
 * 录制与回放：泵产出的每一帧（screencast + 轮询）同时追加进 `recording`（内存、有界：
 * 每份 ≤MAX_FRAMES 帧、全局 ≤MAX_RETAINED_RECORDINGS 份、TTL 30min）。无论有无观看者
 * 都录制（无人观看时泵以 ~0.5fps 节流，保证调度/无人值守执行也能事后回放）。执行结束
 * teardown 不再删注册表，而是置 dead 保留 recording；`handleLiveReplay`（?replay=1[&speed=N]）
 * 按帧时间戳间隔把录制帧重新播一遍后 end，speed 为倍速（1=原速，≤8x）。
 *
 * 动作高亮（blackboard 层）：annotateAction 在被测页面注入 fixed 定位描边框（pointer-events:none、
 * 无文本——避免污染 innerText 断言与 AI 视觉截图），clearAnnotation 由执行器在每个动作的
 * finally 里调用——step 截图 / vision 断言 / aiTask 轮截图全部发生在清除之后，永不被污染。
 */
import { randomUUID } from 'node:crypto';
import type { CDPSession, Page } from 'playwright-core';
import { logger } from '../logger.js';
import {
  MAX_REC_FRAMES,
  REC_TTL_MS,
  redisReady,
  heartbeatSet,
  heartbeatClear,
  publishFrame,
  publishEnd,
  appendRecording,
  expireRecording,
  clearRecording,
  remoteSourceAlive,
  remoteRecordingInfo,
  readRemoteRecording,
  subscribeMirror,
  viewersIncr,
  viewersDecr,
  viewersTouch,
  viewersGet,
} from './liveViewBus.js';

const BOUNDARY = 'frame';
/** 轮询兜底/保活间隔：screencast 帧停滞超过 KEEPALIVE_MS 时每 tick 补一帧截图。 */
const POLL_INTERVAL_MS = 500;
/** 无人观看录制模式的轮询间隔（~0.5fps）：只录不给任何人看，控成本。 */
const POLL_INTERVAL_UNVIEWED_MS = 2000;
/** screencast 帧新鲜度窗口：窗口内有帧就不轮询（静默页每 ~1.2s 保活一帧）。 */
const KEEPALIVE_MS = 1200;
/** 单帧截图软超时：超时/异常跳帧续流（导航中截图可能挂起，不阻断流）。 */
const FRAME_TIMEOUT_MS = 2500;
/** 扇出最小间隔（~5fps）：动画场景 screencast 帧洪泛时丢帧节流。 */
const MIN_FRAME_GAP_MS = 200;
const SCREENCAST_QUALITY = 55;
/** 高亮描边框 DOM id（documentElement 直挂，避开 body 子序选择器）。 */
const MARKER_ID = '__itest_live_marker__';
// 录制保留时长（REC_TTL_MS）与帧数上限（MAX_REC_FRAMES）定义在 liveViewBus（Redis 侧共用同一契约）。
/** 死保留的最大录制份数：超限按最早过期者淘汰（LRU）。 */
const MAX_RETAINED_RECORDINGS = 6;
/** 回放倍速上限（?speed=）：8x 已足够看清每帧动作，再快只是糊。 */
const REPLAY_MAX_SPEED = 8;
/** 过期录制清扫周期（60s，配合 handler 内的懒检查）。 */
const SWEEP_INTERVAL_MS = 60_000;
/** 回放帧间隔钳制：太快连发伤 HDMI 且无必要，太慢失真实节奏。 */
const REPLAY_MIN_GAP_MS = 250;
const REPLAY_MAX_GAP_MS = 2000;
/** 加速后的最小帧间隔：低于此浏览器来不及解码，纯闪。 */
const REPLAY_FAST_MIN_GAP_MS = 40;
/** 镜像观看者计数续期节流：出帧时 viewersTouch 至少隔这么久（TTL 15s 的一半）。 */
const MIRROR_TOUCH_INTERVAL_MS = 5000;

interface LiveResponse {
  writeHead: (status: number, headers: Record<string, string>) => void;
  write: (chunk: string | Buffer) => boolean;
  end: (chunk?: string | Buffer) => void;
  writableEnded: boolean;
}

interface Subscriber {
  writePart(buf: Buffer): void;
  end(): void;
}

/** 录制帧：与原帧时间戳一并保留，回放按差值定节奏。 */
interface RecordedFrame {
  ts: number;
  data: Buffer;
}

interface LiveEntry {
  /** liveKey（fanout/record/tick 发布到 Redis 桥时用）。 */
  key: string;
  page: Page | null;
  /** 工具/执行器收尾置位：live 帧泵据此结束流（浏览器即将关闭，继续截图只会报错）；
   *  回放要求 dead 且 recording 非空——dead 后 record() 不再追加，录制数组不可变。 */
  dead: boolean;
  subscribers: Set<Subscriber>;
  /** 桥上镜像观看者数（其他副本上的浏览器连接）：经观看者回写计数，tick 每拍刷新。
   *  档位/screencast/高亮决策一律用 viewers() = 本地订阅 + 此值——这是「跨副本观看降档」的治本点。 */
  remoteViewers: number;
  /** 最近一帧（新订阅者连接即回放，避免 <img> 空白到下一次 repaint）。 */
  lastFrame: Buffer | null;
  cdp: CDPSession | null;
  pollTimer: NodeJS.Timeout | null;
  /** 最近一次扇出时刻（节流 + 保活判定共用）。 */
  lastFrameAt: number;
  /** 最近一次入录制时刻（录制节流：观看 500ms / 无人 2000ms 一帧）。 */
  lastRecordAt: number;
  pumping: boolean;
  /** 截图在途：慢/挂起页面防重叠（每 tick 一行跳帧，不并发叠截图）。 */
  inFlight: boolean;
  /** 录制帧（追加、超 MAX_REC_FRAMES 掉最旧）。teardown 后冻结为回放素材。 */
  recording: RecordedFrame[];
  /** teardown 时置 now+TTL；live 期为 null；过期由懒检查 + 清扫定时器删除。 */
  expiresAt: number | null;
}

/** liveKey → 画面源（本进程承接的那份执行；跨副本观看/回放由 liveViewBus 的 Redis 桥补齐）。 */
const registry = new Map<string, LiveEntry>();
/** page → 画面源：执行器 annotateAction 凭 page 反查（无观看者直接短路）。 */
const pageMap = new WeakMap<Page, LiveEntry>();

export interface LiveViewHandle {
  key: string;
  /** 画面源切换：计划运行逐用例换 page、verify 的 replay 阶段新开 page 后无缝切换。 */
  setPage(p: Page): void;
  /** 收尾调用：置 dead（live 流结束）+ 保留录制供回放（TTL 内）。 */
  close(): void;
}

/** 注册画面源。key 缺省随机（能力凭证语义）；显式 key（planrun:/case:）重复注册时旧源（含旧录制）被终结。 */
export function registerLiveView(key?: string): LiveViewHandle {
  const k = key ?? randomUUID();
  const old = getEntry(k);
  if (old) teardown(old, k);
  const entry: LiveEntry = {
    key: k,
    page: null, dead: false, subscribers: new Set(), lastFrame: null,
    remoteViewers: 0,
    cdp: null, pollTimer: null, lastFrameAt: 0, lastRecordAt: 0, pumping: false, inFlight: false,
    recording: [], expiresAt: null,
  };
  registry.set(k, entry);
  // 桥上声明源就位（心跳）并清掉上一轮同 key 录制；无 REDIS_URL 时两者均 no-op
  clearRecording(k);
  heartbeatSet(k);
  return {
    key: k,
    setPage: (p) => {
      if (entry.dead) return;
      if (entry.page) pageMap.delete(entry.page);
      stopPump(entry);
      entry.page = p;
      pageMap.set(p, entry);
      startPump(entry); // 无人观看也起泵：录制正在发生的执行
    },
    close: () => {
      teardown(entry, k);
    },
  };
}

/** 取出条目：懒 TTL 检查——死且过期的直接删除（配合 ensureSweep 的周期清扫）。 */
function getEntry(key: string): LiveEntry | undefined {
  const e = registry.get(key);
  if (e && e.dead && e.expiresAt !== null && e.expiresAt <= Date.now()) {
    registry.delete(key);
    return undefined;
  }
  return e;
}

/** 收尾：end 现有订阅（<img> 定格最后一帧）、置 dead、页面源释放；录制保留在 registry 供回放。 */
function teardown(entry: LiveEntry, key: string): void {
  entry.dead = true;
  stopPump(entry);
  for (const s of entry.subscribers) s.end();
  entry.subscribers.clear();
  if (entry.page) pageMap.delete(entry.page);
  entry.page = null;
  entry.lastFrame = null;
  entry.expiresAt = Date.now() + REC_TTL_MS;
  // 桥上收尾：镜像订阅者收到 end 帧后结束响应；录制 TTL 自此刻起算；心跳撤除。
  publishEnd(key);
  heartbeatClear(key);
  expireRecording(key);
  evictRetained();
  ensureSweep();
}

// ── 帧泵 ─────────────────────────────────────────────────────────────────────

/** 有效观看者 = 本地 HTTP 订阅者 + 桥上镜像观看者。泵节流、screencast 开关、高亮注入
 *  都按它决策；只看本地订阅数会让跨副本观看者拿到「无人观看」档（~0.5fps + 无高亮）。 */
function viewers(entry: LiveEntry): number {
  return entry.subscribers.size + entry.remoteViewers;
}

/** 追加到录制（有界）。dead 后不追加——回放期间数组不可变。录制节流与泵节流一致：
 *  观看 500ms 一帧（screencast 洪泛被压到 ~2fps），无人 2000ms 一帧。 */
function record(entry: LiveEntry, buf: Buffer): void {
  if (entry.dead) return;
  const now = Date.now();
  const cadence = viewers(entry) > 0 ? POLL_INTERVAL_MS : POLL_INTERVAL_UNVIEWED_MS;
  if (now - entry.lastRecordAt < cadence) return;
  entry.lastRecordAt = now;
  entry.recording.push({ ts: now, data: buf });
  if (entry.recording.length > MAX_REC_FRAMES) entry.recording.shift();
  appendRecording(entry.key, now, buf);
}

function fanout(entry: LiveEntry, buf: Buffer): void {
  entry.lastFrame = buf;
  entry.lastFrameAt = Date.now();
  record(entry, buf);
  for (const s of entry.subscribers) s.writePart(buf);
  publishFrame(entry.key, Date.now(), buf);
}

/** 起泵：有 page 即跑（无人观看也录制），tick 自适应节流。 */
function startPump(entry: LiveEntry): void {
  if (entry.dead || !entry.page) return;
  if (!entry.pumping) {
    entry.pumping = true;
    tick(entry); // 首 tick 立即执行：起 screencast / 录首帧 / 出第一帧
    return;
  }
  // 已泵转（无人观看录制中）接新观看者：切回观看节流 + 立即同步 screencast，不额外截图（避免干扰轮询节奏）。
  syncViewers(entry);
  if (entry.pollTimer) { clearTimeout(entry.pollTimer); entry.pollTimer = null; }
  entry.pollTimer = setTimeout(
    () => tick(entry),
    viewers(entry) > 0 ? POLL_INTERVAL_MS : POLL_INTERVAL_UNVIEWED_MS,
  );
}

/** 泵状态与观看者同步：有人看 → 确保 CDP 提帧；没人看 → 停 CDP（录制仍由慢节流轮询兜底）。 */
function syncViewers(entry: LiveEntry): void {
  if (entry.dead || !entry.page) return;
  if (viewers(entry) === 0) {
    stopScreencast(entry);
  } else if (!entry.cdp) {
    void tryStartScreencast(entry).catch(() => undefined);
  }
}

function tick(entry: LiveEntry): void {
  if (entry.dead || !entry.page) {
    stopPump(entry);
    return;
  }
  heartbeatSet(entry.key); // 桥上心跳：证明源副本仍活着（页面挂起无帧时也不过期）
  // 跨副本观看者回写：镜像观看者不计入本地 subscribers，靠 Redis 计数补齐档位决策
  void viewersGet(entry.key).then((n) => { entry.remoteViewers = n; }).catch(() => undefined);
  syncViewers(entry);
  if (!entry.inFlight && Date.now() - entry.lastFrameAt >= KEEPALIVE_MS) {
    entry.inFlight = true;
    void (async () => {
      try {
        const buf = await withTimeout(entry.page!.screenshot({ type: 'jpeg', quality: SCREENCAST_QUALITY }));
        if (entry.dead || !entry.page) return;
        fanout(entry, buf);
      } catch {
        // 跳帧：导航/页面崩溃等瞬态错误直接丢弃，流保持打开
      } finally {
        entry.inFlight = false;
      }
    })();
  }
  entry.pollTimer = setTimeout(
    () => tick(entry),
    viewers(entry) > 0 ? POLL_INTERVAL_MS : POLL_INTERVAL_UNVIEWED_MS,
  );
}

/** 断开 live 帧源（screencast）但保留泵：最后一位观看者离开时调用，录制仍继续。 */
function stopScreencast(entry: LiveEntry): void {
  const session = entry.cdp;
  entry.cdp = null;
  if (session) {
    void session.send('Page.stopScreencast' as never).catch(() => undefined);
    void session.detach().catch(() => undefined);
  }
}

/** 停泵：断开 screencast + 清轮询定时器（teardown / page 切换时调用）。 */
function stopPump(entry: LiveEntry): void {
  entry.pumping = false;
  if (entry.pollTimer) { clearTimeout(entry.pollTimer); entry.pollTimer = null; }
  stopScreencast(entry);
}

/** CDPSession.send 是 ProtocolMapping 键控泛型；screencast 控制命令以宽松签名调用（参数按 CDP 协议手写）。 */
type RawCdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

/** CDP screencast：repaint 驱动推帧（能捕捉亚秒级动作与高亮闪烁）。启动失败静默——poll 兜底。 */
async function tryStartScreencast(entry: LiveEntry): Promise<void> {
  const page = entry.page;
  if (!page || entry.dead || entry.cdp) return;
  const session = await page.context().newCDPSession(page).catch(() => null);
  if (!session || entry.dead || !entry.page || entry.pumping === false) {
    void session?.detach().catch(() => undefined);
    return;
  }
  const cdpSend = session.send.bind(session) as unknown as RawCdpSend;
  session.on('Page.screencastFrame' as never, (ev: { data?: string; sessionId?: number }) => {
    if (!ev || typeof ev.data !== 'string') return;
    if (entry.cdp !== session) return; // 泵已停/已切换：不再消费
    void cdpSend('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => undefined);
    if (Date.now() - entry.lastFrameAt < MIN_FRAME_GAP_MS) return; // 节流：丢帧（ack 已发）
    if (entry.dead || viewers(entry) === 0) return;
    fanout(entry, Buffer.from(ev.data, 'base64'));
  });
  try {
    await cdpSend('Page.startScreencast', {
      format: 'jpeg',
      quality: SCREENCAST_QUALITY,
      maxWidth: 1280,
      maxHeight: 800,
      everyNthFrame: 1,
    });
  } catch {
    void session.detach().catch(() => undefined);
    return;
  }
  if (entry.dead || viewers(entry) === 0) {
    void cdpSend('Page.stopScreencast').catch(() => undefined);
    void session.detach().catch(() => undefined);
    return;
  }
  entry.cdp = session;
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('frame timeout')), FRAME_TIMEOUT_MS)),
  ]);
}

// ── HTTP handlers ────────────────────────────────────────────────────────────────

/** MJPEG 流响应头（本地源与 Redis 镜像共用；X-Accel-Buffering：生产 nginx 反代禁缓冲，
 *  否则帧被攒批、画面卡成幻灯片，SSE 同理）。 */
const LIVE_HEADERS: Record<string, string> = {
  'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  'X-Accel-Buffering': 'no',
};

/** 把 MJPEG 帧写进 HTTP 响应的订阅者（本地源与镜像共用）。onBytes 可选：累计转发字节（断流观测）。 */
function resSubscriber(res: LiveResponse, onBytes?: (n: number) => void): Subscriber {
  return {
    writePart: (buf) => {
      if (res.writableEnded) return;
      res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`);
      res.write(buf);
      res.write('\r\n');
      onBytes?.(buf.length);
    },
    end: () => { if (!res.writableEnded) res.end(); },
  };
}

/** 单连接流收尾观测：durationMs 突短 = 连接被掐（ip_hash 漂移/代理超时）；bytes=0 = 整条
 *  连接从未出帧（源未就绪/桥断）。「跑着跑着没画面」类问题先看这两列。 */
function logStreamEnd(path: 'local' | 'mirror', key: string, startedAt: number, bytes: number): void {
  logger.info({ key, path, durationMs: Date.now() - startedAt, bytes }, 'live stream ended');
}

/** GET .../live/:key —— 鉴权在路由层完成，这里只管流。无活跃源 404；源存在但 page 未就绪则挂起等待首帧。
 *  仅限 live（运行中）；执行结束后请走 handleLiveReplay（?replay=1）。
 *  本地无源但 Redis 桥上有活跃心跳（执行 job 落在别的副本）→ 转成镜像：订阅桥上帧流转发。
 *  无 REDIS_URL 时 fallback 全同步（行为与单进程版一致）；有 Redis 时仅在本地无源分支多一个 await。 */
export async function handleLiveView(req: { on: (event: 'close', fn: () => void) => void }, res: LiveResponse, key: string): Promise<void> {
  const entry = getEntry(key);
  if (!entry || entry.dead) {
    if (!redisReady() || !(await remoteSourceAlive(key))) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end();
      return;
    }
    // 镜像路径：订阅桥上频道，帧/end 帧分别转发/收尾（不二次录制——录制在源副本上完）。
    // 观看者回写：连接即 INCR；onEnd 与 close（正常 end 后 Node 仍会触发 close）只 DECR 一次；
    // 出帧时 ≥5s 节流 touch 续计数 TTL，防长连接被源端误判无人观看而降档。
    res.writeHead(200, LIVE_HEADERS);
    viewersIncr(key);
    const startedAt = Date.now();
    let bytes = 0;
    let lastTouchAt = 0;
    let done = false;
    let unsubscribe: () => void = () => {};
    const finish = () => {
      if (done) return;
      done = true;
      unsubscribe();
      sub.end(); // 源副本 end 帧/断连 → 结束镜像 HTTP 响应（否则浏览器 <img> 与 nginx 连接挂死）
      viewersDecr(key);
      logStreamEnd('mirror', key, startedAt, bytes);
    };
    const sub = resSubscriber(res, (n) => {
      bytes += n;
      if (Date.now() - lastTouchAt >= MIRROR_TOUCH_INTERVAL_MS) {
        lastTouchAt = Date.now();
        viewersTouch(key);
      }
    });
    unsubscribe = subscribeMirror(key, {
      onFrame: (_ts, jpeg) => sub.writePart(jpeg),
      onEnd: finish,
    });
    req.on('close', finish);
    return;
  }
  res.writeHead(200, LIVE_HEADERS);

  const startedAt = Date.now();
  let bytes = 0;
  const sub = resSubscriber(res, (n) => { bytes += n; });
  entry.subscribers.add(sub);
  // 连接即回放最近一帧（静默页 <img> 不空白；首观看者启动泵）
  if (entry.lastFrame) sub.writePart(entry.lastFrame);
  const wasEmpty = entry.subscribers.size === 1;
  if (wasEmpty) startPump(entry);
  req.on('close', () => {
    entry.subscribers.delete(sub);
    // 最后一位观看者离开：停 CDP 保活，但泵继续以慢节流录制（无人值守执行留回放）。
    // viewers() 计入桥上镜像观看者——跨副本仍有人看就不降档（观看者回写治本点）。
    if (viewers(entry) === 0) stopScreencast(entry);
    logStreamEnd('local', key, startedAt, bytes);
  });
}

/** 回放倍速：解析 ?speed=，非法/缺失 → 1；钳制到 [0.25, REPLAY_MAX_SPEED]。 */
export function replaySpeedOf(query: unknown): number {
  const raw = typeof query === 'object' && query !== null ? (query as Record<string, unknown>).speed : undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(n, REPLAY_MAX_SPEED) : 1;
}

/** GET .../live/:key?replay=meta —— 探测本轮录制是否仍可回放（本进程内存录制，或 Redis 桥上
 *  源副本的录制：TTL 过期 / LRU 淘汰 / 进程重启后就没了）。前端据此决定是否显示「回放」按钮，
 *  避免点下去撞 404。可回放返回 { available:true, frames, durationMs, expiresAt }；否则
 *  { available:false }（仍 200）。 */
export async function handleLiveReplayMeta(res: LiveResponse, key: string): Promise<void> {
  const entry = getEntry(key); // 懒 TTL 检查：过期条目在此之前已被删出注册表
  const frames = entry && entry.dead ? entry.recording : [];
  let body: Record<string, unknown>;
  if (frames.length > 0) {
    body = {
      available: true,
      frames: frames.length,
      durationMs: frames[frames.length - 1]!.ts - frames[0]!.ts,
      expiresAt: entry!.expiresAt,
    };
  } else {
    const info = redisReady() ? await remoteRecordingInfo(key) : null;
    body = info
      ? {
          available: true,
          frames: info.frames,
          durationMs: Math.max(info.lastTs - info.firstTs, 0),
          expiresAt: Date.now() + info.ttlMs,
        }
      : { available: false };
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** GET .../live/:key?replay=1[&speed=N] —— 执行结束后的录制回放：按录制帧时间戳间隔把整段重播一遍，
 *  末帧后 end。`speed` 为倍速（1=原速，默认；上限 8），帧间隔按倍率压缩、下限 REPLAY_FAST_MIN_GAP_MS。
 *  每连接独立游标，天然支持并发回放。录制不存在/未结束/已过期 → 404。
 *  本地无录制时从 Redis 桥读源副本的录制（无 REDIS_URL → 同步 404，行为不变）。 */
export async function handleLiveReplay(
  req: { on: (event: 'close', fn: () => void) => void },
  res: LiveResponse,
  key: string,
  opts?: { speed?: number },
): Promise<void> {
  const entry = getEntry(key);
  let frames: RecordedFrame[] = entry && entry.dead ? entry.recording : [];
  if (frames.length === 0 && redisReady()) frames = await readRemoteRecording(key);
  if (frames.length === 0) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end();
    return;
  }
  const speed = Math.min(Math.max(opts?.speed ?? 1, 0.25), REPLAY_MAX_SPEED);
  res.writeHead(200, LIVE_HEADERS);

  let i = 0;
  let timer: NodeJS.Timeout | null = null;
  const step = (): void => {
    timer = null;
    if (i >= frames.length) {
      res.end();
      return;
    }
    const f = frames[i++]!;
    res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${f.data.length}\r\n\r\n`);
    res.write(f.data);
    res.write('\r\n');
    if (i >= frames.length) {
      res.end();
      return;
    }
    const raw = Math.min(Math.max(frames[i]!.ts - f.ts, REPLAY_MIN_GAP_MS), REPLAY_MAX_GAP_MS);
    timer = setTimeout(step, Math.max(Math.round(raw / speed), REPLAY_FAST_MIN_GAP_MS));
  };
  req.on('close', () => {
    if (timer) clearTimeout(timer);
    timer = null;
  });
  step();
}

// ── 录制淘汰 ─────────────────────────────────────────────────────────────────

/** 死保留超限淘汰：按最早过期排序，删最老（LRU）；live 中的条目不受累。 */
function evictRetained(): void {
  const retained: Array<{ key: string; expiresAt: number }> = [];
  for (const [k, e] of registry) {
    if (e.dead && e.expiresAt !== null && e.recording.length > 0) retained.push({ key: k, expiresAt: e.expiresAt });
  }
  retained.sort((a, b) => a.expiresAt - b.expiresAt);
  while (retained.length > MAX_RETAINED_RECORDINGS) registry.delete(retained.shift()!.key);
}

let sweepTimer: NodeJS.Timeout | null = null;
/** 周期清扫过期录制（懒检查的兜底；空闲进程也回收内存）。 */
function ensureSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, e] of registry) {
      if (e.dead && e.expiresAt !== null && e.expiresAt <= now) registry.delete(k);
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

// ── 动作高亮（blackboard）────────────────────────────────────────────────────

/**
 * 在目标元素位置注入红色描边框（无文本、aria-hidden、pointer-events:none）。
 * 仅在有观看者时注入——无人观看的执行（CI/调度）零 DOM 干扰。
 * box 可为取值函数（懒求值）：boundingBox() 是 CDP 往返，无人观看时跳过，执行零额外开销；
 * 传 null 直接跳过（动作无命中元素）。
 * 生命周期契约：调用方（cdp dispatch / aiTask 动作循环）必须在动作结束的 finally 里
 * clearAnnotation，保证其后的 step 截图 / vision 断言 / LLM 轮截图不被污染。
 */
export async function annotateAction(
  page: Page,
  box: { x: number; y: number; width: number; height: number } | null | (() => Promise<{ x: number; y: number; width: number; height: number } | null>),
): Promise<void> {
  if (!box) return;
  const entry = pageMap.get(page);
  if (!entry || entry.dead || viewers(entry) === 0) return;
  if (typeof box === 'function') box = await box().catch(() => null);
  if (!box) return;
  await page.evaluate(
    ([id, b]) => {
      document.getElementById(id)?.remove();
      const d = document.createElement('div');
      d.id = id;
      d.setAttribute('aria-hidden', 'true');
      d.style.cssText =
        `position:fixed;left:${b.x}px;top:${b.y}px;width:${b.width}px;height:${b.height}px;` +
        'outline:2px solid #ff4d4f;outline-offset:1px;background:rgba(255,77,79,0.10);' +
        'pointer-events:none;z-index:2147483647;';
      document.documentElement.appendChild(d);
    },
    [MARKER_ID, box] as [string, { x: number; y: number; width: number; height: number }],
  ).catch(() => undefined);
}

/** 移除高亮框；未注册/无人观看时零开销直返（从未注入）。 */
export async function clearAnnotation(page: Page): Promise<void> {
  if (!pageMap.has(page)) return;
  await page.evaluate((id) => {
    document.getElementById(id)?.remove();
  }, MARKER_ID).catch(() => undefined);
}