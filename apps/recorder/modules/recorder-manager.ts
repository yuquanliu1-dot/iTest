import { generateLocators, deriveSemantic, type Locator } from './selector-core.js';
import { detectComponent } from './component-detector.js';

// re-exported for content/recorder.js's locate-frame use: selector-core.js contains bare module specifiers
// (@medv/finder) that the browser's dynamic import() cannot resolve — only this esbuild bundle is usable.
export { generateLocators };

/** Recording options: configured by popup / panel and passed in via start({...}). Empty options equal the historical defaults. */
export interface RecorderOptions {
  /** Preferred data-* attribute name (finder will use `[name=...]` from the whole parent chain). Default `data-testid`. */
  preferredDataAttribute?: string;
  /** Whether to record hover steps. Default false — hover is one of the biggest noise sources; enable it when debugging. */
  recordHover?: boolean;
  /** fill debounce merge window (ms). Consecutive input only persists once the user pauses longer than this. Default 500. */
  fillFlushMs?: number;
}

export type RecordedStepType = 'click' | 'fill' | 'press' | 'hover' | 'check' | 'select' | 'upload' | 'aiTask' | 'scroll';

export interface RecordedStep {
  type: RecordedStepType;
  target: Locator[];
  /** fill/select value; upload's file name */
  value?: string;
  /** press key name (Playwright key name, e.g. "Enter") */
  key?: string;
  /** click multi-click count: 2=double 3=triple; plain click omits it. Comes from native dblclick (e.detail). */
  clickCount?: 2 | 3;
  /** scroll's absolute scroll position (scroll container / window level = scrollingElement). */
  scrollTop?: number;
  scrollLeft?: number;
  /** check's target state */
  checked?: boolean;
  url: string;
  timestamp: number;
  /** Identifier of the currently recorded tab (injected by the content script), used to switch page context at replay. */
  tabRef?: string;
  /** Sniffed component kind; only present when select/treeSelect matched. */
  componentKind?: 'select' | 'tree' | 'treeSelect';
  /** Password field: when true, the value is stored encrypted by the API side before the PUT. */
  sensitive?: boolean;
  /** The test_attachments.id corresponding to an upload step; empty while recording, bound later by the editor. */
  fileId?: string;
  /** Semantic locator determined at recording time: semanticRole reuses data-testid / name; contextText takes the element's first innerText segment. */
  intentLocator?: { semanticRole: string; contextText?: string };
}

type StepHandler = (step: RecordedStep) => void;

/** Delegates to selector-core.deriveSemantic: data-testid / name / stable semantic class / aria-label, four-level fallback. */
function buildIntentLocator(el: Element): RecordedStep['intentLocator'] {
  return deriveSemantic(el);
}

/** Captcha signature: a hit on the input's own id/name/class/placeholder/aria-label or the associated label text marks it as a captcha input. */
const CAPTCHA_RE = /captcha|验证码|校验码|validcode|verifycode|vercode|vcode/i;

function isCaptchaInput(el: HTMLInputElement): boolean {
  if (el.type === 'password') return false;
  const labelText = (() => {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l?.textContent) return l.textContent;
    }
    const wrap = el.closest('label');
    return wrap?.textContent ?? '';
  })();
  return [el.id, el.name, el.className, el.placeholder, el.getAttribute('aria-label') ?? '', labelText]
    .some((s) => typeof s === 'string' && s.length > 0 && CAPTCHA_RE.test(s));
}

/**
 * Browser-side recording coordinator:
 *  - click / input / change / mouseover / dblclick / scroll events are captured and produce multi-candidate locators.
 *  - change subtyping: checkbox → check (with target state), select → select (with selected value), file → upload (file name only).
 *  - click is emitted after a 250ms delay: a dblclick arriving within the window upgrades it to clickCount=2/3 (table-row double-click into details);
 *    repeated same-signature clicks within 200ms are deduped (a double-click's second press produces no separate step).
 *  - scroll is recorded with an event-stream debounce: after 350ms of stillness the scroll container's absolute position is emitted
 *    (window level anchors 'html'); net displacement <10px produces no step.
 *  - When an input event fires, a mouseover immediately after is skipped to avoid "type = hover" noise.
 *  - mouseover must dwell on the same element ≥500ms to produce a hover (dwell threshold): elements swept past on the cursor's
 *    path are not recorded; internal micro-moves of an already-recorded element are not re-recorded; click/input/leaving cancels a dwell not yet due.
 *  - 1.5s locator-signature dedupe window: when the e.target reference changed (React re-render / same-text hover across the DOM tree)
 *    but the selector did not, the second hover is not emitted — avoiding consecutive duplicate steps pointing at the same text position.
 *  - Hover over inputs is not emitted (hover-when-input suppression); checkbox/radio/select/file and value-less inputs produce no fill.
 *  - During setPaused(true) all events are ignored (used by the panel's "pause" / element pick).
 */
export class RecorderManager {
  private active = false;
  private paused = false;
  private options: Required<RecorderOptions> = {
    preferredDataAttribute: 'data-testid',
    recordHover: false,
    fillFlushMs: 250,
  };
  private handler: StepHandler | null = null;
  private listeners: Array<{ el: EventTarget; type: string; fn: EventListener }> = [];
  private lastClick: { signature: string; at: number } | null = null;
  private lastInputAt: number | null = null;
  /** Hover in its dwell threshold: emitted only when the timer comes due. */
  private pendingHover: { el: Element; timer: ReturnType<typeof setTimeout> } | null = null;
  /** The last element whose hover was emitted: its internal micro-moves are not re-recorded. */
  private lastHoverEl: Element | null = null;
  /** The last emitted hover's locator signature + timestamp:
   *  blocks duplicate hovers when React re-render changed the e.target reference (but not the selector).
   *  A pure-reference `lastHoverEl.contains()` misses this case — sibling elements with identical hover text would be treated as new targets. */
  private lastHoverSig: { signature: string; at: number } | null = null;
  private static DEDUP_WINDOW_MS = 200;
  private static HOVER_SUPPRESS_AFTER_INPUT_MS = 300;
  private static HOVER_DWELL_MS = 500;
  private static HOVER_SIG_DEDUP_MS = 1500;
  /** fill step merge window: consecutive input events persist only after the user pauses longer than this.
   *  250ms is a reasonable threshold for "fast-typing pause" — common IMEs / autofill fire input at a 200-300ms rhythm,
   *  500ms is too long and would swallow the intermediate step of "typed a segment then waited". Overridable via options.fillFlushMs. */
  private static FILL_FLUSH_MS_DEFAULT = 250;
  /** aiTask (captcha) merge window: captcha inputs repeatedly fire input on React re-render or backend timed refresh;
   *  within 1.5s the same locator produces only one aiTask. */
  private static AITASK_DEDUP_MS = 1500;
  /** Password autofill fallback dedupe window: Chrome autofill / 1Password may fire change repeatedly across blur+focus cycles;
   *  the same locator produces only one fill per 1s to avoid duplicate steps. */
  private static SENSITIVE_CHANGE_DEDUP_MS = 1000;
  /** click emit delay window: a dblclick within the window upgrades the pending single click to double. Must be slightly larger
   *  than the interval between two clicks (browsers judge dblclick within ~500ms); 250ms is the same order as the fill merge
   *  window and imperceptible in interaction. */
  private static CLICK_FLUSH_MS = 250;
  /** scroll event-stream stillness window: reset continuously while scrolling; the final position is emitted only after still for this long. */
  private static SCROLL_SETTLE_MS = 350;
  /** scroll minimum net displacement (px): |Δtop|+|Δleft| from start to end below this counts as micro-move noise and produces no step. */
  private static SCROLL_MIN_DELTA = 10;
  /** The last sensitive-field change fallback emission's locator signature + timestamp: deduped within the SENSITIVE_CHANGE_DEDUP_MS window. */
  private lastSensitiveChange: { signature: string; at: number } | null = null;

  /** fill step awaiting flush: input events accumulate the value; emitted only when due. */
  private pendingFill: {
    target: HTMLInputElement;
    timer: ReturnType<typeof setTimeout>;
    intentLocator?: ReturnType<typeof buildIntentLocator>;
    /** Sequence start point: flushed in order with pendingClick/pendingScroll to preserve user action timing. */
    since: number;
  } | null = null;
  /** click step awaiting flush: emitted after CLICK_FLUSH_MS delay; a dblclick within the window upgrades it to
   *  clickCount=2 (previously double-clicks were compressed into 1 click — element-ui table-row double-click into
   *  details is a high-frequency scenario). sig is the pending locator signature: a new click on a different target
   *  settles the old pending first; the same target overwrites it (the dblclick's second press goes through the dedupe
   *  return or the overwrite path — upgrade semantics unchanged). */
  private pendingClick: {
    locs: Locator[];
    sig: string;
    timer: ReturnType<typeof setTimeout>;
    intentLocator?: ReturnType<typeof buildIntentLocator>;
    since: number;
  } | null = null;
  /** scroll step awaiting flush: scroll event-stream debounce; absolute position emitted after SCROLL_SETTLE_MS of stillness.
   *  startTop/startLeft are the start of this scroll sequence — micro-moves with net displacement below SCROLL_MIN_DELTA produce no step. */
  private pendingScroll: {
    el: Element;
    windowScroll: boolean;
    startTop: number;
    startLeft: number;
    top: number;
    left: number;
    timer: ReturnType<typeof setTimeout>;
    since: number;
  } | null = null;
  /** The last aiTask step's locator signature + timestamp: same-signature dedupe within the 1.5s window. */
  private lastAiTaskSig: { signature: string; at: number } | null = null;

  start(handler: StepHandler, options: RecorderOptions = {}) {
    // Idempotence: the same replica may receive 'start' multiple times without a stop in between (background re-sends
    // the start broadcast to all living replicas on every complete). Detach the old listeners before attaching new ones,
    // so stacked document-level capture listeners don't capture one click multiple times.
    this.detachListeners();
    this.active = true;
    this.paused = false;
    this.options = {
      preferredDataAttribute: options.preferredDataAttribute ?? 'data-testid',
      recordHover: options.recordHover ?? false,
      fillFlushMs: options.fillFlushMs ?? RecorderManager.FILL_FLUSH_MS_DEFAULT,
    };
    this.handler = handler;
    this.lastClick = null;
    this.lastInputAt = null;
    this.cancelPendingHover();
    this.lastHoverEl = null;
    this.lastHoverSig = null;
    this.cancelPendingFill();
    this.cancelPendingClick();
    this.cancelPendingScroll();
    this.lastAiTaskSig = null;
    this.lastSensitiveChange = null;
    this.attachListeners();
  }

  stop() {
    // Settle pending click / scroll first (the handler is still attached and canRecord still true at this moment):
    // click used to be emitted synchronously before the delay window existed, so "stop recording right after the last
    // action" never lost steps — this preserves that invariant.
    this.flushPendingClick();
    this.flushPendingScroll();
    this.active = false;
    this.paused = false;
    this.handler = null;
    this.cancelPendingHover();
    this.cancelPendingFill();
    this.cancelPendingClick();
    this.cancelPendingScroll();
    this.lastHoverEl = null;
    this.lastHoverSig = null;
    this.lastAiTaskSig = null;
    this.detachListeners();
  }

  setPaused(paused: boolean) {
    this.paused = paused;
  }

  isPaused() {
    return this.paused;
  }

  /** Updates recording options (called when the panel toggles hover / fillFlushMs). Takes effect even mid-recording. */
  setOptions(options: RecorderOptions) {
    this.options = {
      preferredDataAttribute: options.preferredDataAttribute ?? this.options.preferredDataAttribute,
      recordHover: options.recordHover ?? this.options.recordHover,
      fillFlushMs: options.fillFlushMs ?? this.options.fillFlushMs,
    };
  }

  getOptions(): RecorderOptions {
    return { ...this.options };
  }

  private canRecord() {
    return this.active && !this.paused;
  }

  private cancelPendingHover() {
    if (this.pendingHover) {
      clearTimeout(this.pendingHover.timer);
      this.pendingHover = null;
    }
  }

  /** Flush the pending fill: user paused typing for 500ms, blur, change fired, or switching between stop/start. */
  private cancelPendingFill() {
    if (this.pendingFill) {
      clearTimeout(this.pendingFill.timer);
      this.pendingFill = null;
    }
  }

  private cancelPendingClick() {
    if (this.pendingClick) {
      clearTimeout(this.pendingClick.timer);
      this.pendingClick = null;
    }
  }

  private cancelPendingScroll() {
    if (this.pendingScroll) {
      clearTimeout(this.pendingScroll.timer);
      this.pendingScroll = null;
    }
  }

  private flushPendingClick() {
    if (!this.pendingClick) return;
    const { locs, timer, intentLocator } = this.pendingClick;
    this.pendingClick = null;
    clearTimeout(timer);
    if (!this.canRecord()) return;
    this.handler?.({
      type: 'click',
      target: locs,
      url: location.href,
      timestamp: Date.now(),
      ...(intentLocator ? { intentLocator } : {}),
    });
  }

  private flushPendingScroll() {
    if (!this.pendingScroll) return;
    const p = this.pendingScroll;
    this.pendingScroll = null;
    clearTimeout(p.timer);
    if (!this.canRecord()) return;
    if (!p.el.isConnected) return;
    // Net displacement too small / scrolled back: scroll micro-move noise produces no step.
    const moved = Math.abs(p.top - p.startTop) + Math.abs(p.left - p.startLeft);
    if (moved < RecorderManager.SCROLL_MIN_DELTA) return;
    // Window-level scrolling anchors to scrollingElement (always <html> in standards mode, a single css 'html' candidate
    // suffices — replay's evaluate of el.scrollTop is the window scroll); element-level scrolling uses the regular candidate chain.
    const locs: Locator[] = p.windowScroll ? [{ strategy: 'css', value: 'html' }] : generateLocators(p.el);
    const intentLocator = p.windowScroll ? undefined : buildIntentLocator(p.el);
    this.handler?.({
      type: 'scroll',
      target: locs,
      scrollTop: p.top,
      scrollLeft: p.left,
      url: location.href,
      timestamp: Date.now(),
      ...(intentLocator ? { intentLocator } : {}),
    });
  }

  /** Emits pending click / scroll sorted by each one's sequence start time (fill untouched — it has its own debounce
   *  semantics, managed separately by the input/change/blur entries). Used by high-frequency entries like input, so the
   *  click→input / scroll→input step order isn't scrambled by pending windows. */
  private flushInteractions() {
    const jobs: Array<{ since: number; run: () => void }> = [];
    if (this.pendingClick) jobs.push({ since: this.pendingClick.since, run: () => this.flushPendingClick() });
    if (this.pendingScroll) jobs.push({ since: this.pendingScroll.since, run: () => this.flushPendingScroll() });
    jobs.sort((a, b) => a.since - b.since);
    for (const j of jobs) j.run();
  }

  /** click + fill + scroll all settled (sorted by sequence start). Used by "input finalized" entries like
   *  change/keydown/blur and by explicit interaction entries other than dblclick. */
  private flushAllTransient() {
    this.flushInteractions();
    this.flushPendingFill();
  }

  private flushPendingFill() {
    if (!this.pendingFill) return;
    const { target, intentLocator } = this.pendingFill;
    this.pendingFill = null;
    if (!this.canRecord()) return;
    // React controlled inputs may remount the whole node when validation fails / an error message appears: the old node
    // is detached and all subsequent typing goes into the new node. The old node only holds the value prefix from its
    // time (e.g. "a"); emitting it would be a fragment fill.
    // Skip detached targets — the new node's flush will carry the complete value.
    if (!target.isConnected) return;
    const value = target.value;
    const isSensitive = target.type === 'password'
      || /password/i.test(target.name ?? '')
      || /password/i.test(target.id ?? '');
    this.handler?.({
      type: 'fill',
      target: generateLocators(target),
      value,
      url: location.href,
      timestamp: Date.now(),
      sensitive: isSensitive || undefined,
      ...(intentLocator ? { intentLocator } : {}),
    });
  }

  private aiTaskSignature(target: Element): string {
    return generateLocators(target)
      .filter((l) => l.strategy === 'role' || l.strategy === 'testId' || l.strategy === 'text')
      .map((l) => `${l.strategy}:${l.value}`)
      .join('|');
  }

  private attachListeners() {
    // The in-page control panel (#itest-recorder-panel-host, injected by content/panel.js) lives in the host page's DOM;
    // dragging the title bar, hovering, clicking its buttons all fire capture events on document. Skipped uniformly at the
    // handler entry: the panel's Shadow DOM defaults to composed=false, so e.target lands on the host and a contains hit suffices.
    const isOnRecorderPanel = (e: Event) => {
      const host = document.getElementById('itest-recorder-panel-host');
      if (!host) return false;
      const path = typeof e.composedPath === 'function' ? e.composedPath() : null;
      if (path && path.includes(host)) return true;
      return host.contains(e.target as Node);
    };

    /** Elements that themselves carry role / data-testid / name / known interactive classes are not layout containers.
     *  Otherwise, if the parent chain hits at least 1 stable semantic class (glass-card / auth-form-shell etc.),
     *  treat it as a "page-level container" and don't record the hover. */
    function isLayoutContainer(el: Element): boolean {
      if (el.getAttribute('role')) return false;
      if (el.getAttribute('data-testid') || el.getAttribute('data-test-id')) return false;
      if (el.getAttribute('name')) return false;
      // "Self-leaf UI" like button / a / summary / label is rarely deliberately hovered by users (clicking is their semantics),
      // but their hovers generally shouldn't be recorded either — hovering a button is mostly transit along the cursor's path.
      // Just let them proceed to signature dedupe (a hover is usually followed by click / input).
      let cur: Element | null = el.parentElement;
      let depth = 0;
      while (cur && depth < 4) {
        const cls = (cur.getAttribute('class') || '').split(/\s+/);
        if (cls.some((c) => /^(?:glass-card|glass-panel|auth-form-shell|auth-form-panel|auth-page|main-content|group-nav-tile|project-card|group)$/.test(c))) {
          return true;
        }
        cur = cur.parentElement;
        depth += 1;
      }
      return false;
    }

    const onClick = (e: Event) => {
      if (!this.canRecord()) return;
      if (isOnRecorderPanel(e)) return;
      this.cancelPendingHover();
      // Clicking a button / elsewhere: flush the current input's accumulated fill, otherwise characters typed before the
      // last pause are lost; pending click/scroll (rapid consecutive actions) also settle in order, preserving step timing.
      this.flushAllTransient();
      const target = e.target as Element;
      if (!target) return;
      const locs = generateLocators(target);
      const sig = locs.map((l) => `${l.strategy}:${l.value}`).join('|');
      const now = Date.now();
      if (this.lastClick && this.lastClick.signature === sig && now - this.lastClick.at < RecorderManager.DEDUP_WINDOW_MS) {
        this.lastClick.at = now;
        // The second press of a double/triple click: don't reset pendingClick (wait for dblclick to decide the upgrade;
        // if dblclick is swallowed by the page and never arrives, the timer emits a single click when due — one more
        // rescue than the old "compress into 1 click" behavior)
        return;
      }
      this.lastClick = { signature: sig, at: now };
      // A pending click on a different target settles first (two different targets clicked within 250ms each leave a step);
      // the old same-target pending is NOT flushed — the dblclick upgrade depends on it (the second press beyond the 200ms
      // dedupe window reaches here and overwrites the old pending, so when dblclick arrives it upgrades the latest press
      // and the double-click always totals one step).
      if (this.pendingClick && this.pendingClick.sig !== sig) this.flushPendingClick();
      // click is emitted after CLICK_FLUSH_MS delay: a dblclick within the window upgrades it to clickCount=2/3,
      // otherwise the timer emits a single click when due. Previously double-clicks were compressed into 1 click,
      // so scenarios like table-row double-click into details couldn't be recorded.
      const intentLocator = buildIntentLocator(target);
      const timer = setTimeout(() => {
        if (this.pendingClick && this.pendingClick.timer === timer) this.flushPendingClick();
      }, RecorderManager.CLICK_FLUSH_MS);
      this.pendingClick = { locs, sig, timer, intentLocator: intentLocator ?? undefined, since: now };
    };
    const onDblClick = (e: Event) => {
      if (!this.canRecord()) return;
      if (isOnRecorderPanel(e)) return;
      this.cancelPendingHover();
      const target = e.target as Element;
      if (!target) return;
      // Normal case: a same-target click is always pending before a double-click (the second click goes through the
      // dedupe return) — take it and upgrade to double-click.
      const taken = this.pendingClick;
      this.pendingClick = null;
      if (taken) clearTimeout(taken.timer);
      // Remaining pendings (fill/scroll) settle in order first: fill → double-click.
      this.flushPendingFill();
      this.flushPendingScroll();
      this.lastClick = null;
      const detail = (e as MouseEvent).detail ?? 2;
      const clickCount: 2 | 3 = detail >= 3 ? 3 : 2;
      // Fallback for pendingClick having been flushed early: regenerate candidates from the dblclick's own target.
      const locs = taken ? taken.locs : generateLocators(target);
      const intentLocator = taken ? taken.intentLocator : buildIntentLocator(target);
      this.handler?.({
        type: 'click',
        target: locs,
        clickCount,
        url: location.href,
        timestamp: Date.now(),
        ...(intentLocator ? { intentLocator } : {}),
      });
    };
    // scroll events don't bubble; a capture listener on document intercepts scrolling of any element/document.
    // Event-stream debounce: while scrolling, keep resetting the timer and updating the final position; after
    // SCROLL_SETTLE_MS of stillness, emit the absolute position (replay doesn't depend on the start).
    // Window-level scrolling (target=document/scrollingElement) anchors to 'html'.
    const onScroll = (e: Event) => {
      if (!this.canRecord()) return;
      if (isOnRecorderPanel(e)) return;
      const maybe = e.target as Element | null;
      if (!maybe) return;
      // Document has no scrollTop (elements do) — used to distinguish document-level from element-level scrolling.
      const se = document.scrollingElement;
      const isWindowScroll = maybe === se || (maybe as { scrollTop?: unknown }).scrollTop === undefined;
      const el = isWindowScroll ? (se ?? document.documentElement) : maybe;
      // Not discriminated via instanceof Element (unreliable across realms / in jsdom tests — same convention as onChange);
      // a scroll event's target is only ever an element or document, and the window branch already anchored to documentElement.
      if (!el.isConnected) return;
      const top = Math.max(0, Math.round(el.scrollTop));
      const left = Math.max(0, Math.round(el.scrollLeft));
      const now = Date.now();
      if (this.pendingScroll && this.pendingScroll.el !== el) {
        // Container switched: settle the old one first (the user scrolled two regions).
        this.flushPendingScroll();
      }
      const timer = setTimeout(() => {
        if (this.pendingScroll && this.pendingScroll.timer === timer) this.flushPendingScroll();
      }, RecorderManager.SCROLL_SETTLE_MS);
      if (this.pendingScroll) {
        this.pendingScroll.top = top;
        this.pendingScroll.left = left;
        clearTimeout(this.pendingScroll.timer);
        this.pendingScroll.timer = timer;
      } else {
        this.pendingScroll = { el, windowScroll: isWindowScroll, startTop: top, startLeft: left, top, left, timer, since: now };
      }
    };
    const onInput = (e: Event) => {
      if (!this.canRecord()) return;
      if (isOnRecorderPanel(e)) return;
      this.cancelPendingHover();
      // Pending click/scroll settle in order first (click→input order not scrambled by pending windows);
      // fill is not flushed here — it has its own debounce merge window.
      this.flushInteractions();
      const target = e.target as HTMLInputElement;
      if (!target) return;
      // select/radio produce select/check steps via change, checkbox produces check via change, file produces upload via change;
      // non-form targets like contenteditable have no value property and produce no fill.
      const tag = (target.tagName ?? '').toLowerCase();
      if (tag === 'select') return;
      if (target.type === 'checkbox' || target.type === 'radio' || target.type === 'file') return;
      const value = (target as { value?: string }).value;
      if (value === undefined) return;
      const isSensitive = target.type === 'password'
        || /password/i.test(target.name ?? '')
        || /password/i.test(target.id ?? '');
      this.lastInputAt = Date.now();
      const intentLocator = buildIntentLocator(target);
      // Captcha input → aiTask step (at replay, AI recognizes the image in real time and fills it in).
      // Same-locator dedupe within a 1.5s window: captcha inputs repeatedly fire input on React re-render or backend
      // timed refresh; without dedupe you'd get 6+ identical aiTasks in a row.
      if (!isSensitive && isCaptchaInput(target)) {
        const sig = this.aiTaskSignature(target);
        if (this.lastAiTaskSig && this.lastAiTaskSig.signature === sig && Date.now() - this.lastAiTaskSig.at < RecorderManager.AITASK_DEDUP_MS) {
          this.lastAiTaskSig = { signature: sig, at: Date.now() };
          return;
        }
        this.lastAiTaskSig = { signature: sig, at: Date.now() };
        this.handler?.({
          type: 'aiTask',
          target: generateLocators(target),
          value: '识别验证码图片中的字符并填入验证码输入框',
          url: location.href,
          timestamp: Date.now(),
          ...(intentLocator ? { intentLocator } : {}),
        });
        return;
      }
      // Regular input: debounce merge + accumulation on the same input. Flush the old one when switching to another input.
      // Note pendingFill holds a target reference; if its value is rewritten again within the flush window, reading the
      // latest value at flush time is correct.
      if (this.pendingFill && this.pendingFill.target !== target) {
        this.flushPendingFill();
      }
      this.cancelPendingFill();
      const flushMs = this.options.fillFlushMs;
      const timer = setTimeout(() => {
        // Only flush the pendingFill whose current timer is still attached: prevents this callback from picking up and
        // emitting a leftover step after cancelPendingFill already cleared the timer between keystrokes.
        if (this.pendingFill && this.pendingFill.timer === timer) {
          this.flushPendingFill();
        }
      }, flushMs);
      this.pendingFill = { target, timer, intentLocator: intentLocator ?? undefined, since: Date.now() };
    };
    const onBlur = (e: Event) => {
      // Force-flush the current fill + pending click/scroll when the user blurs (clicking elsewhere / Tab away),
      // so a navigation within 500ms doesn't lose steps.
      this.flushAllTransient();
    };
    // Enter inside an input submits (form without a submit button / users who habitually press Enter): previously there
    // was no click event at all, so the whole login action was lost. On keydown, flush the accumulated fill first
    // (replay order = fill the complete value → press Enter), then emit the press step. Only record Enter on text-class
    // inputs — pressing Enter while a button is focused makes the browser dispatch a click, which onClick records;
    // recording it here too would duplicate. Enter during IME composition (isComposing / keyCode 229) confirms a
    // candidate word rather than submitting — skip it.
    const onKeyDown = (e: Event) => {
      if (!this.canRecord()) return;
      if (isOnRecorderPanel(e)) return;
      const ke = e as KeyboardEvent;
      if (ke.key !== 'Enter') return;
      if (ke.isComposing || ke.keyCode === 229) return;
      const target = ke.target as HTMLInputElement | HTMLTextAreaElement | null;
      if (!target) return;
      const tag = (target.tagName ?? '').toLowerCase();
      if (tag !== 'input' && tag !== 'textarea') return;
      if (tag === 'input') {
        const t = (target as HTMLInputElement).type;
        if (t === 'checkbox' || t === 'radio' || t === 'file' || t === 'button' || t === 'submit') return;
      }
      if (!target.isConnected) return;
      this.flushAllTransient();
      const intentLocator = buildIntentLocator(target);
      this.handler?.({
        type: 'press',
        target: generateLocators(target),
        key: 'Enter',
        url: location.href,
        timestamp: Date.now(),
        ...(intentLocator ? { intentLocator } : {}),
      });
    };
    // Chrome autofill / 1Password / LastPass and other password-manager extensions write value via the native setter directly,
    // **without firing** input events, only change events (and usually in one shot after blur).
    // onChange already flushes pending fill; this adds a "change without pending" path for password inputs,
    // so even with zero keyboard input from the user (pure autofill) the password value still gets recorded.
    // Note: dedupe is mandatory — the same locator's change may fire repeatedly (autofill refill, blur then focus again).
    const onChangePasswordAutofill = (e: Event) => {
      const target = e.target as HTMLInputElement | null;
      if (!target) return;
      if (target.tagName?.toLowerCase() !== 'input') return;
      const isSensitive = target.type === 'password'
        || /password/i.test(target.name ?? '')
        || /password/i.test(target.id ?? '');
      if (!isSensitive) return;
      if (!target.isConnected) return;
      const value = target.value;
      if (!value) return; // empty values not reported (consistent with the empty string on focus before manual typing)
      const intentLocator = buildIntentLocator(target);
      const sig = generateLocators(target)
        .filter((l) => l.strategy === 'role' || l.strategy === 'testId' || l.strategy === 'text')
        .map((l) => `${l.strategy}:${l.value}`)
        .join('|');
      const now = Date.now();
      if (this.lastSensitiveChange && this.lastSensitiveChange.signature === sig
          && now - this.lastSensitiveChange.at < RecorderManager.SENSITIVE_CHANGE_DEDUP_MS) {
        return;
      }
      this.lastSensitiveChange = { signature: sig, at: now };
      // If a pending fill already exists on the same target, the 250ms flush would overwrite it; emit once directly here
      // so autofill also persists immediately (the value is finalized — no need to wait for debounce).
      this.cancelPendingFill();
      this.handler?.({
        type: 'fill',
        target: generateLocators(target),
        value,
        url: location.href,
        timestamp: now,
        sensitive: true,
        ...(intentLocator ? { intentLocator } : {}),
      });
    };
    const onChange = (e: Event) => {
      if (!this.canRecord()) return;
      if (isOnRecorderPanel(e)) return;
      // change firing means the user's input on the current input is finalized (blur / Enter / option picked): flush all
      // pendings (fill + click/scroll in order).
      this.flushAllTransient();
      onChangePasswordAutofill(e);
      const target = e.target as HTMLInputElement | HTMLSelectElement;
      if (!target) return;
      const now = Date.now();
      // Discriminated by tagName/type rather than instanceof: the latter is unreliable across realms (jsdom tests).
      const tag = (target.tagName ?? '').toLowerCase();
      if (tag === 'input') {
        const t = (target as HTMLInputElement).type;
        if (t === 'checkbox' || t === 'radio') {
          const intentLocator = buildIntentLocator(target);
          this.handler?.({
            type: 'check',
            target: generateLocators(target),
            checked: (target as HTMLInputElement).checked,
            url: location.href,
            timestamp: now,
            ...(intentLocator ? { intentLocator } : {}),
          });
          return;
        }
        if (t === 'file') {
          const files = (target as HTMLInputElement).files;
          const intentLocator = buildIntentLocator(target);
          this.handler?.({
            type: 'upload',
            target: generateLocators(target),
            value: files?.[0]?.name ?? '',
            url: location.href,
            timestamp: now,
            ...(intentLocator ? { intentLocator } : {}),
          });
        }
        return;
      }
      if (tag === 'select') {
        const comp = detectComponent(target as Element);
        const intentLocator = buildIntentLocator(target);
        this.handler?.({
          type: 'select',
          target: generateLocators(target),
          value: target.value,
          url: location.href,
          timestamp: now,
          componentKind: comp?.kind,
          ...(intentLocator ? { intentLocator } : {}),
        });
      }
    };
    const onMouseOver = (e: Event) => {
      if (!this.canRecord()) return;
      if (isOnRecorderPanel(e)) return;
      // Hover not recorded by default: too many hover noise sources (layout containers, body/html, repeated passes over
      // the same element…). Most recorded steps would be unintentional "I looked here". Enabled explicitly only in
      // debug / inspector mode.
      if (!this.options.recordHover) return;
      const target = e.target as Element;
      if (!target) return;
      const sinceInput = this.lastInputAt !== null ? Date.now() - this.lastInputAt : Infinity;
      if (sinceInput < RecorderManager.HOVER_SUPPRESS_AFTER_INPUT_MS) {
        this.cancelPendingHover();
        return;
      }
      const tag = (target.tagName ?? '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        this.cancelPendingHover();
        return;
      }
      // Hover on body / html shouldn't be recorded: when the cursor leaves all meaningful elements onto blank space,
      // e.target becomes body or html and the dwell timer would still fire a noise step when due. Drop it directly.
      // tagName compared via toLowerCase for jsdom returning uppercase 'BODY'/'HTML'.
      const rootTag = tag.toLowerCase();
      if (rootTag === 'body' || rootTag === 'html') {
        this.cancelPendingHover();
        return;
      }
      // Page-level layout container hovers are also not recorded: for elements like `<form>` / `<div class="auth-form-shell">` /
      // `<div class="glass-card project-card">`, e.target is usually their blank space or a child — there is no user
      // intent of "hovering this container". Rule: no role / data-testid / name of its own plus at least 1 stable semantic
      // class on the parent chain (glass-card / auth-form-shell etc.) → treat as a layout container and drop.
      if (isLayoutContainer(target)) {
        this.cancelPendingHover();
        return;
      }
      // Internal micro-moves of an already-hovered element are not re-recorded; sweeping within a dwelling element doesn't interrupt its timer.
      if (this.lastHoverEl?.contains(target)) return;
      if (this.pendingHover?.el.contains(target)) return;
      // Locator-signature-level dedupe: React re-renders / sibling elements with identical hover text (e.target reference
      // changed but selector unchanged) are blocked by the 1.5s window, avoiding duplicate steps.
      // The signature uses only role/testId/text (semantic candidates); Tailwind utilities in CSS paths easily shift on
      // re-render, and xpath indexes shift with DOM order — both unstable, unusable for comparison.
      const sig = generateLocators(target)
        .filter((l) => l.strategy === 'role' || l.strategy === 'testId' || l.strategy === 'text')
        .map((l) => `${l.strategy}:${l.value}`)
        .join('|');
      if (this.lastHoverSig && this.lastHoverSig.signature === sig && Date.now() - this.lastHoverSig.at < RecorderManager.HOVER_SIG_DEDUP_MS) return;
      // Cursor entering a new element: reset the dwell timer (elements swept past on the path never reach the threshold).
      this.cancelPendingHover();
      const el = target;
      const timer = setTimeout(() => {
        this.pendingHover = null;
        if (!this.canRecord()) return;
        this.lastHoverEl = el;
        this.lastHoverSig = { signature: sig, at: Date.now() };
        const intentLocator = buildIntentLocator(el);
        this.handler?.({
          type: 'hover',
          target: generateLocators(el),
          url: location.href,
          timestamp: Date.now(),
          ...(intentLocator ? { intentLocator } : {}),
        });
      }, RecorderManager.HOVER_DWELL_MS);
      this.pendingHover = { el, timer };
    };
    const onMouseLeave = (e: Event) => {
      if (!this.canRecord()) return;
      if (isOnRecorderPanel(e)) return;
      // Leaving the element (or its ancestors) means leaving the dwell target: cancel the dwell not yet due (mouseover won't come again when the cursor exits the window / blank area).
      const t = e.target as Element;
      if (this.pendingHover && t.contains(this.pendingHover.el)) this.cancelPendingHover();
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('dblclick', onDblClick, true);
    document.addEventListener('scroll', onScroll, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onChange, true);
    // blur force-flushes fill — avoids losing the last input within 500ms when focus switches away.
    document.addEventListener('focusout', onBlur, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('mouseleave', onMouseLeave, true);
    this.listeners.push(
      { el: document, type: 'click', fn: onClick },
      { el: document, type: 'dblclick', fn: onDblClick },
      { el: document, type: 'scroll', fn: onScroll },
      { el: document, type: 'input', fn: onInput },
      { el: document, type: 'change', fn: onChange },
      { el: document, type: 'focusout', fn: onBlur },
      { el: document, type: 'keydown', fn: onKeyDown },
      { el: document, type: 'mouseover', fn: onMouseOver },
      { el: document, type: 'mouseleave', fn: onMouseLeave },
    );
  }

  private detachListeners() {
    for (const l of this.listeners) {
      l.el.removeEventListener(l.type, l.fn, true);
    }
    this.listeners = [];
  }

  isActive() {
    return this.active;
  }
}