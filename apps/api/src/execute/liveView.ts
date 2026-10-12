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
 * teardown 不再删注册表，而是置 dead 保留 recording；`handleLiveReplay`（?replay=1）
 * 按帧时间戳间隔把录制帧重新播一遍后 end。
 *
 * 动作高亮（blackboard 层）：annotateAction 在被测页面注入 fixed 定位描边框（pointer-events:none、
 * 无文本——避免污染 innerText 断言与 AI 视觉截图），clearAnnotation 由执行器在每个动作的
 * finally 里调用——step 截图 / vision 断言 / aiTask 轮截图全部发生在清除之后，永不被污染。
 */
import { randomUUID } from 'node:crypto';
import type { CDPSession, Page } from 'playwright-core';

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
/** 录制保留时长：执行结束（teardown）后录音在内存保留 30 分钟，期间可回放。 */
const RECORD_TTL_MS = 30 * 60_000;
/** 死保留的最大录制份数：超限按最早过期者淘汰（LRU）。 */
const MAX_RETAINED_RECORDINGS = 6;
/** 每份录制帧数上限（观看 10min / 无人 40min 的窗口）；每帧约 60-120KB。 */
const MAX_FRAMES = 1200;
/** 过期录制清扫周期（60s，配合 handler 内的懒检查）。 */
const SWEEP_INTERVAL_MS = 60_000;
/** 回放帧间隔钳制：太快连发伤 HDMI 且无必要，太慢失真实节奏。 */
const REPLAY_MIN_GAP_MS = 250;
const REPLAY_MAX_GAP_MS = 2000;

interface LiveResponse {
  writeHead: (status: number, headers: Record<string, string>) => void;
  write: (chunk: string | Buffer) => boolean;
  end: () => void;
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
  page: Page | null;
  /** 工具/执行器收尾置位：live 帧泵据此结束流（浏览器即将关闭，继续截图只会报错）；
   *  回放要求 dead 且 recording 非空——dead 后 record() 不再追加，录制数组不可变。 */
  dead: boolean;
  subscribers: Set<Subscriber>;
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
  /** 录制帧（追加、超 MAX_FRAMES 掉最旧）。teardown 后冻结为回放素材。 */
  recording: RecordedFrame[];
  /** teardown 时置 now+TTL；live 期为 null；过期由懒检查 + 清扫定时器删除。 */
  expiresAt: number | null;
}

/** liveKey → 画面源（进程内存，同 loginStateCache 模式；api 单进程承载 HTTP 与全部执行，无跨实例问题）。 */
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
    page: null, dead: false, subscribers: new Set(), lastFrame: null,
    cdp: null, pollTimer: null, lastFrameAt: 0, lastRecordAt: 0, pumping: false, inFlight: false,
    recording: [], expiresAt: null,
  };
  registry.set(k, entry);
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
  entry.expiresAt = Date.now() + RECORD_TTL_MS;
  evictRetained();
  ensureSweep();
}

// ── 帧泵 ─────────────────────────────────────────────────────────────────────

/** 追加到录制（有界）。dead 后不追加——回放期间数组不可变。录制节流与泵节流一致：
 *  观看 500ms 一帧（screencast 洪泛被压到 ~2fps），无人 2000ms 一帧。 */
function record(entry: LiveEntry, buf: Buffer): void {
  if (entry.dead) return;
  const now = Date.now();
  const cadence = entry.subscribers.size > 0 ? POLL_INTERVAL_MS : POLL_INTERVAL_UNVIEWED_MS;
  if (now - entry.lastRecordAt < cadence) return;
  entry.lastRecordAt = now;
  entry.recording.push({ ts: now, data: buf });
  if (entry.recording.length > MAX_FRAMES) entry.recording.shift();
}

function fanout(entry: LiveEntry, buf: Buffer): void {
  entry.lastFrame = buf;
  entry.lastFrameAt = Date.now();
  record(entry, buf);
  for (const s of entry.subscribers) s.writePart(buf);
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
    entry.subscribers.size > 0 ? POLL_INTERVAL_MS : POLL_INTERVAL_UNVIEWED_MS,
  );
}

/** 泵状态与观看者同步：有人看 → 确保 CDP 提帧；没人看 → 停 CDP（录制仍由慢节流轮询兜底）。 */
function syncViewers(entry: LiveEntry): void {
  if (entry.dead || !entry.page) return;
  if (entry.subscribers.size === 0) {
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
    entry.subscribers.size > 0 ? POLL_INTERVAL_MS : POLL_INTERVAL_UNVIEWED_MS,
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
    if (entry.dead || entry.subscribers.size === 0) return;
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
  if (entry.dead || entry.subscribers.size === 0) {
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

/** GET .../live/:key —— 鉴权在路由层完成，这里只管流。无活跃源 404；源存在但 page 未就绪则挂起等待首帧。
 *  仅限 live（运行中）；执行结束后请走 handleLiveReplay（?replay=1）。 */
export function handleLiveView(req: { on: (event: 'close', fn: () => void) => void }, res: LiveResponse, key: string): void {
  const entry = getEntry(key);
  if (!entry || entry.dead) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    // 生产 nginx 反代禁缓冲，否则帧被攒批、画面卡成幻灯片（SSE 同理）
    'X-Accel-Buffering': 'no',
  });

  const sub: Subscriber = {
    writePart: (buf) => {
      if (res.writableEnded) return;
      res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`);
      res.write(buf);
      res.write('\r\n');
    },
    end: () => { if (!res.writableEnded) res.end(); },
  };
  entry.subscribers.add(sub);
  // 连接即回放最近一帧（静默页 <img> 不空白；首观看者启动泵）
  if (entry.lastFrame) sub.writePart(entry.lastFrame);
  const wasEmpty = entry.subscribers.size === 1;
  if (wasEmpty) startPump(entry);
  req.on('close', () => {
    entry.subscribers.delete(sub);
    // 最后一位观看者离开：停 CDP 保活，但泵继续以慢节流录制（无人值守执行留回放）。
    if (entry.subscribers.size === 0) stopScreencast(entry);
  });
}

/** GET .../live/:key?replay=1 —— 执行结束后的录制回放：按录制帧时间戳间隔把整段重播一遍，末帧后 end。
 *  每连接独立游标，天然支持并发回放。录制不存在/未结束/已过期 → 404。 */
export function handleLiveReplay(req: { on: (event: 'close', fn: () => void) => void }, res: LiveResponse, key: string): void {
  const entry = getEntry(key);
  if (!entry || !entry.dead || entry.recording.length === 0) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    'X-Accel-Buffering': 'no',
  });

  const frames = entry.recording; // dead 后不可变：record() 不再追加
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
    const gap = Math.min(Math.max(frames[i]!.ts - f.ts, REPLAY_MIN_GAP_MS), REPLAY_MAX_GAP_MS);
    timer = setTimeout(step, gap);
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
  if (!entry || entry.dead || entry.subscribers.size === 0) return;
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