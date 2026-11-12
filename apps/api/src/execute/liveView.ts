/**
 * Live view (playground): the MJPEG stream (multipart/x-mixed-replace) during headless browser execution,
 * natively decoded by the frontend <img src>. Layering borrowed from the Midscene playground: CDP screencast (repaint-driven,
 * captures sub-second actions/highlights) as primary, polled screenshots as fallback (screencast unavailable/stalled/silent-page keepalive).
 *
 * Multi-subscriber hub: one data pump per view source (liveKey), N HTTP connections fanned out the same frames; with no viewers the pump stops —
 * zero overhead. Two key shapes: random UUID (verify/solidify tools, the key is the capability credential) and stable keys
 * (`planrun:<id>` / `case:<id>`, forwarded after project-visibility auth at the route layer).
 *
 * Recording & replay: every frame the pump produces (screencast + polling) is also appended to `recording` (in-memory, bounded:
 * ≤MAX_FRAMES frames per recording, ≤MAX_RETAINED_RECORDINGS recordings globally, TTL 30min). Recorded regardless of viewers
 * (the pump throttles to ~0.5fps unviewed, so scheduled/unattended executions are replayable afterwards). On finish,
 * teardown no longer deletes the registry entry but marks it dead, keeping the recording; `handleLiveReplay` (?replay=1[&speed=N])
 * replays the recorded frames spaced by their timestamps then ends; speed is the multiplier (1=original, ≤8x).
 *
 * Action highlight (blackboard layer): annotateAction injects a fixed-position outlined box into the SUT page (pointer-events:none,
 * no text — so it can't pollute innerText assertions or AI vision screenshots); clearAnnotation is called by the executor in each action's
 * finally — step screenshots / vision assertions / aiTask turn screenshots all happen after the clear and are never polluted.
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
/** Polling fallback/keepalive interval: when screencast frames stall beyond KEEPALIVE_MS, each tick adds one screenshot frame. */
const POLL_INTERVAL_MS = 500;
/** Unviewed recording-mode polling interval (~0.5fps): records for nobody, cost control. */
const POLL_INTERVAL_UNVIEWED_MS = 2000;
/** Screencast frame freshness window: frames within the window suppress polling (silent pages keepalive one frame every ~1.2s). */
const KEEPALIVE_MS = 1200;
/** Per-frame screenshot soft timeout: on timeout/exception the frame is skipped and the stream continues (screenshots can hang mid-navigation; never block the stream). */
const FRAME_TIMEOUT_MS = 2500;
/** Fan-out minimum gap (~5fps): drops frames to throttle when screencast floods during animations. */
const MIN_FRAME_GAP_MS = 200;
const SCREENCAST_QUALITY = 55;
/** Highlight outline box DOM id (attached directly to documentElement, dodging body child-order selectors). */
const MARKER_ID = '__itest_live_marker__';
// Recording retention (REC_TTL_MS) and frame cap (MAX_REC_FRAMES) are defined in liveViewBus (the Redis side shares the same contract).
/** Max recordings retained dead: over the limit, evict the earliest-expiring one (LRU). */
const MAX_RETAINED_RECORDINGS = 6;
/** Replay speed cap (?speed=): 8x is enough to follow each frame's action; faster is just blur. */
const REPLAY_MAX_SPEED = 8;
/** Expired-recording sweep period (60s, paired with the lazy check inside handlers). */
const SWEEP_INTERVAL_MS = 60_000;
/** Replay frame-gap clamp: firing too fast in bursts hurts HDMI and is unnecessary; too slow loses the real pacing. */
const REPLAY_MIN_GAP_MS = 250;
const REPLAY_MAX_GAP_MS = 2000;
/** Minimum frame gap after speed-up: below this the browser can't decode in time — pure flicker. */
const REPLAY_FAST_MIN_GAP_MS = 40;
/** Mirror-viewer count renewal throttle: on frame out, viewersTouch is called at least this far apart (half the 15s TTL). */
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

/** Recorded frame: kept with the original frame's timestamp; replay paces by the differences. */
interface RecordedFrame {
  ts: number;
  data: Buffer;
}

interface LiveEntry {
  /** liveKey (used when fanout/record/tick publish to the Redis bridge). */
  key: string;
  page: Page | null;
  /** Set by the tool/executor at finish: the live frame pump ends the stream because of it (the browser is about to close; more screenshots would only error);
   *  replay requires dead && recording non-empty — after dead, record() no longer appends; the recording array is immutable. */
  dead: boolean;
  subscribers: Set<Subscriber>;
  /** Mirror viewer count on the bridge (browser connections on other replicas): fed back via viewer counting, refreshed every tick.
   *  Tier/screencast/highlight decisions always use viewers() = local subscribers + this value — the root fix for「跨副本观看降档」. */
  remoteViewers: number;
  /** Latest frame (replayed immediately when a new subscriber connects, so <img> isn't blank until the next repaint). */
  lastFrame: Buffer | null;
  cdp: CDPSession | null;
  pollTimer: NodeJS.Timeout | null;
  /** Last fan-out time (shared by throttling and keepalive judgment). */
  lastFrameAt: number;
  /** Last record time (recording throttle: one frame per 500ms viewed / 2000ms unviewed). */
  lastRecordAt: number;
  pumping: boolean;
  /** Screenshot in flight: prevents overlap on slow/hung pages (one screenshot per tick; while pending, the tick skips rather than stacking). */
  inFlight: boolean;
  /** Recording frames (appended; oldest dropped beyond MAX_REC_FRAMES). Frozen as replay material after teardown. */
  recording: RecordedFrame[];
  /** Set to now+TTL at teardown; null while live; expired entries removed by the lazy check + sweep timer. */
  expiresAt: number | null;
}

/** liveKey → view source (the execution this process hosts; cross-replica viewing/replay is completed by liveViewBus's Redis bridge). */
const registry = new Map<string, LiveEntry>();
/** page → view source: the executor's annotateAction looks the entry up by page (short-circuits when nobody is watching). */
const pageMap = new WeakMap<Page, LiveEntry>();

export interface LiveViewHandle {
  key: string;
  /** View-source switching: plan runs swap the page per case; verify's replay phase switches seamlessly after opening a new page. */
  setPage(p: Page): void;
  /** Finish call: mark dead (the live stream ends) + keep the recording for replay (within TTL). */
  close(): void;
}

/** Register a view source. The key defaults to random (capability-credential semantics); re-registering an explicit key (planrun:/case:) tears down the old source (including its old recording). */
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
  // Declare the source ready on the bridge (heartbeat) and clear the previous run's same-key recording; both are no-op without REDIS_URL
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
      startPump(entry); // the pump starts even unviewed: record the execution as it happens
    },
    close: () => {
      teardown(entry, k);
    },
  };
}

/** Fetch an entry: lazy TTL check — dead and expired entries are deleted outright (paired with ensureSweep's periodic sweep). */
function getEntry(key: string): LiveEntry | undefined {
  const e = registry.get(key);
  if (e && e.dead && e.expiresAt !== null && e.expiresAt <= Date.now()) {
    registry.delete(key);
    return undefined;
  }
  return e;
}

/** Teardown: end existing subscribers (<img> freezes on the last frame), mark dead, release the page source; the recording stays in the registry for replay. */
function teardown(entry: LiveEntry, key: string): void {
  entry.dead = true;
  stopPump(entry);
  for (const s of entry.subscribers) s.end();
  entry.subscribers.clear();
  if (entry.page) pageMap.delete(entry.page);
  entry.page = null;
  entry.lastFrame = null;
  entry.expiresAt = Date.now() + REC_TTL_MS;
  // Bridge-side teardown: mirror subscribers end their responses on the end frame; the recording TTL starts now; the heartbeat is withdrawn.
  publishEnd(key);
  heartbeatClear(key);
  expireRecording(key);
  evictRetained();
  ensureSweep();
}

// ── Frame pump ──────────────────────────────────────────────────────────────

/** Effective viewers = local HTTP subscribers + bridge mirror viewers. Pump throttling, the screencast switch, highlight injection
 *  all decide by it; counting only local subscribers would give cross-replica viewers the「无人观看」tier (~0.5fps, no highlight). */
function viewers(entry: LiveEntry): number {
  return entry.subscribers.size + entry.remoteViewers;
}

/** Append to the recording (bounded). Not appended after dead — the array stays immutable during replay. The recording throttle matches the pump's:
 *  one frame per 500ms viewed (screencast floods compressed to ~2fps), one per 2000ms unviewed. */
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

/** Start the pump: runs whenever there's a page (records even unviewed), tick self-adaptive throttling. */
function startPump(entry: LiveEntry): void {
  if (entry.dead || !entry.page) return;
  if (!entry.pumping) {
    entry.pumping = true;
    tick(entry); // the first tick runs immediately: start screencast / record the first frame / emit the first frame
    return;
  }
  // Pump already running (recording unviewed) gains a viewer: switch back to viewed throttling + sync screencast immediately, no extra screenshot (avoid disturbing the polling cadence).
  syncViewers(entry);
  if (entry.pollTimer) { clearTimeout(entry.pollTimer); entry.pollTimer = null; }
  entry.pollTimer = setTimeout(
    () => tick(entry),
    viewers(entry) > 0 ? POLL_INTERVAL_MS : POLL_INTERVAL_UNVIEWED_MS,
  );
}

/** Sync pump state with viewers: someone watching → ensure CDP is producing frames; nobody → stop CDP (recording still covered by the slow-throttle polling fallback). */
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
  heartbeatSet(entry.key); // bridge heartbeat: proves the source replica is alive (doesn't expire even when a hung page produces no frames)
  // Cross-replica viewer feedback: mirror viewers aren't counted in local subscribers; the Redis count fills in the tier decision
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
        // Skip the frame: transient errors (navigation/page crash) are dropped outright; the stream stays open
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

/** Disconnect the live frame source (screencast) but keep the pump: called when the last viewer leaves; recording continues. */
function stopScreencast(entry: LiveEntry): void {
  const session = entry.cdp;
  entry.cdp = null;
  if (session) {
    void session.send('Page.stopScreencast' as never).catch(() => undefined);
    void session.detach().catch(() => undefined);
  }
}

/** Stop the pump: disconnect screencast + clear the polling timer (called at teardown / page switch). */
function stopPump(entry: LiveEntry): void {
  entry.pumping = false;
  if (entry.pollTimer) { clearTimeout(entry.pollTimer); entry.pollTimer = null; }
  stopScreencast(entry);
}

/** CDPSession.send is ProtocolMapping-keyed generic; screencast control commands are invoked with a loose signature (params hand-written per the CDP protocol). */
type RawCdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

/** CDP screencast: repaint-driven frame push (captures sub-second actions and highlight flickers). Startup failure is silent — poll is the fallback. */
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
    if (entry.cdp !== session) return; // pump stopped/switched: stop consuming
    void cdpSend('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => undefined);
    if (Date.now() - entry.lastFrameAt < MIN_FRAME_GAP_MS) return; // throttle: drop the frame (ack already sent)
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

/** MJPEG stream response headers (shared by local sources and the Redis mirror; X-Accel-Buffering: buffering disabled on the prod nginx reverse proxy,
 *  otherwise frames get batched and the picture stutters like a slideshow — SSE has the same problem). */
const LIVE_HEADERS: Record<string, string> = {
  'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  'X-Accel-Buffering': 'no',
};

/** Subscriber that writes MJPEG frames into the HTTP response (shared by local sources and the mirror). onBytes optional: accumulates forwarded bytes (stalled-stream observability). */
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

/** Per-connection stream-end observability: an abruptly short durationMs = the connection was cut (ip_hash drift/proxy timeout); bytes=0 = the whole
 *  connection never emitted a frame (source not ready/bridge down). For「跑着跑着没画面」-class issues, look at these two fields first. */
function logStreamEnd(path: 'local' | 'mirror', key: string, startedAt: number, bytes: number): void {
  logger.info({ key, path, durationMs: Date.now() - startedAt, bytes }, 'live stream ended');
}

/** GET .../live/:key — auth happens at the route layer; this only streams. No active source → 404; source exists but the page isn't ready → hang waiting for the first frame.
 *  Live (running) only; after the execution ends use handleLiveReplay (?replay=1).
 *  No local source but the Redis bridge has an active heartbeat (the execution job landed on another replica) → turn into a mirror: subscribe to the bridge's frame stream and forward.
 *  Without REDIS_URL the fallback is fully synchronous (same behavior as the single-process version); with Redis, only the no-local-source branch gains one await. */
export async function handleLiveView(req: { on: (event: 'close', fn: () => void) => void }, res: LiveResponse, key: string): Promise<void> {
  const entry = getEntry(key);
  if (!entry || entry.dead) {
    if (!redisReady() || !(await remoteSourceAlive(key))) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end();
      return;
    }
    // Mirror path: subscribe to the bridge channel; frames/end frames are forwarded/ended respectively (no second recording — recording completes on the source replica).
    // Viewer feedback: INCR on connect; onEnd and close (Node still fires close after a normal end) DECR only once;
    // on frames, a ≥5s-throttled touch renews the count TTL, so long connections aren't misjudged as unviewed by the source and downgraded.
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
      sub.end(); // the source replica's end frame/disconnect → end the mirror HTTP response (otherwise the browser <img> and the nginx connection hang)
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
  // Replay the latest frame on connect (silent pages keep <img> non-blank; the first viewer starts the pump)
  if (entry.lastFrame) sub.writePart(entry.lastFrame);
  const wasEmpty = entry.subscribers.size === 1;
  if (wasEmpty) startPump(entry);
  req.on('close', () => {
    entry.subscribers.delete(sub);
    // Last viewer left: stop CDP keepalive, but the pump keeps recording at slow throttle (unattended executions leave a replay).
    // viewers() counts the bridge's mirror viewers — cross-replica watchers still prevent downgrading (the root fix via viewer feedback).
    if (viewers(entry) === 0) stopScreencast(entry);
    logStreamEnd('local', key, startedAt, bytes);
  });
}

/** Replay speed: parse ?speed=; invalid/missing → 1; clamped to [0.25, REPLAY_MAX_SPEED]. */
export function replaySpeedOf(query: unknown): number {
  const raw = typeof query === 'object' && query !== null ? (query as Record<string, unknown>).speed : undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(n, REPLAY_MAX_SPEED) : 1;
}

/** GET .../live/:key?replay=meta — probe whether this run's recording is still replayable (this process's in-memory recording, or the
 *  source replica's recording on the Redis bridge: gone after TTL expiry / LRU eviction / process restart). The frontend decides from this
 *  whether to show the「回放」button, avoiding a 404 on click. Replayable returns { available:true, frames, durationMs, expiresAt }; otherwise
 *  { available:false } (still 200). */
export async function handleLiveReplayMeta(res: LiveResponse, key: string): Promise<void> {
  const entry = getEntry(key); // lazy TTL check: expired entries were already deleted from the registry before this point
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

/** GET .../live/:key?replay=1[&speed=N] — post-execution recording replay: replays the whole run spaced by the recorded frames' timestamp gaps,
 *  ends after the last frame. `speed` is the multiplier (1=original, the default; cap 8); frame gaps are compressed by the ratio with a floor of REPLAY_FAST_MIN_GAP_MS.
 *  Each connection has an independent cursor, naturally supporting concurrent replays. No recording / not finished / expired → 404.
 *  With no local recording, reads the source replica's recording from the Redis bridge (no REDIS_URL → synchronous 404, behavior unchanged). */
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

// ── Recording eviction ────────────────────────────────────────────────────────

/** Dead-retention over-limit eviction: sort by earliest expiry, delete the oldest (LRU); live entries are unaffected. */
function evictRetained(): void {
  const retained: Array<{ key: string; expiresAt: number }> = [];
  for (const [k, e] of registry) {
    if (e.dead && e.expiresAt !== null && e.recording.length > 0) retained.push({ key: k, expiresAt: e.expiresAt });
  }
  retained.sort((a, b) => a.expiresAt - b.expiresAt);
  while (retained.length > MAX_RETAINED_RECORDINGS) registry.delete(retained.shift()!.key);
}

let sweepTimer: NodeJS.Timeout | null = null;
/** Periodically sweep expired recordings (the lazy check's fallback; idle processes reclaim memory too). */
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

// ── Action highlight (blackboard) ───────────────────────────────────────────

/**
 * Injects a red outlined box at the target element's position (no text, aria-hidden, pointer-events:none).
 * Injected only when someone is watching — unviewed executions (CI/scheduled) get zero DOM interference.
 * box may be a getter function (lazy evaluation): boundingBox() is a CDP round trip, skipped when unviewed — zero extra cost for the execution;
 * pass null to skip outright (the action had no matched element).
 * Lifecycle contract: the caller (cdp dispatch / aiTask action loop) must clearAnnotation in the action's finally,
 * so that subsequent step screenshots / vision assertions / LLM turn screenshots stay unpolluted.
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

/** Remove the highlight box; returns at zero cost when unregistered/unviewed (never injected). */
export async function clearAnnotation(page: Page): Promise<void> {
  if (!pageMap.has(page)) return;
  await page.evaluate((id) => {
    document.getElementById(id)?.remove();
  }, MARKER_ID).catch(() => undefined);
}