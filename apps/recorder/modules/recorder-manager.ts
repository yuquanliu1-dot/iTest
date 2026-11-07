import { generateLocators, deriveSemantic, type Locator } from './selector-core.js';
import { detectComponent } from './component-detector.js';

// re-export 给 content/recorder.js 的 locate-frame 用：selector-core.js 含裸模块说明符
// （@medv/finder），浏览器里动态 import() 解析不了，只有这份 esbuild 打包产物可用。
export { generateLocators };

/** 录制选项：popup / panel 配置后通过 start({...}) 传入。空 options 等价于历史默认行为。 */
export interface RecorderOptions {
  /** 优先 data-* 属性名（finder 会把整条父链的 `[name=...]` 都用上）。默认 `data-testid`。 */
  preferredDataAttribute?: string;
  /** 是否录 hover 步骤。默认 false——hover 是最大的噪声源之一，调试时再开。 */
  recordHover?: boolean;
  /** fill debounce 合并窗（ms）。用户连续输入超过这个时长才落库。默认 500。 */
  fillFlushMs?: number;
}

export type RecordedStepType = 'click' | 'fill' | 'press' | 'hover' | 'check' | 'select' | 'upload' | 'aiTask' | 'scroll';

export interface RecordedStep {
  type: RecordedStepType;
  target: Locator[];
  /** fill/select 的值；upload 的文件名 */
  value?: string;
  /** press 的键名（Playwright 键名，如 "Enter"） */
  key?: string;
  /** click 的连击数：2=双击 3=三连击；缺省单击。来自原生 dblclick（e.detail）。 */
  clickCount?: 2 | 3;
  /** scroll 的绝对滚动位置（滚动容器 / 窗口级=scrollingElement）。 */
  scrollTop?: number;
  scrollLeft?: number;
  /** check 的目标状态 */
  checked?: boolean;
  url: string;
  timestamp: number;
  /** 当前录制 tab 的标识符（由 content script 注入），用于回放时切换页面上下文。 */
  tabRef?: string;
  /** 嗅探到的组件类型；只有命中 select/treeSelect 时才有。 */
  componentKind?: 'select' | 'tree' | 'treeSelect';
  /** 密码字段：true 时值会在 PUT 前由接口端加密存储。 */
  sensitive?: boolean;
  /** upload 步骤对应的 test_attachments.id；录制时为空，由编辑器后绑定。 */
  fileId?: string;
  /** 录制阶段确定的语义定位：semanticRole 复用 data-testid / name；contextText 取元素 innerText 第一段。 */
  intentLocator?: { semanticRole: string; contextText?: string };
}

type StepHandler = (step: RecordedStep) => void;

/** 委托给 selector-core.deriveSemantic：data-testid / name / 稳定语义 class / aria-label 四级回退。 */
function buildIntentLocator(el: Element): RecordedStep['intentLocator'] {
  return deriveSemantic(el);
}

/** 验证码特征：input 自身的 id/name/class/placeholder/aria-label 或关联 label 文案命中即认为是验证码输入框。 */
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
 * 浏览器端录制协调器：
 *  - click / input / change / mouseover / dblclick / scroll 事件被捕获并生成多候选 locator。
 *  - change 细分：checkbox → check（带目标状态），select → select（带选中值），file → upload（只记文件名）。
 *  - click 延迟 250ms 发射：窗口内 dblclick 到达则升级为 clickCount=2/3（表格行双击进详情）；
 *    200ms 内同签名重复 click 去重（双击的第二击不产独立步骤）。
 *  - scroll 以事件流 debounce 记录：静止 350ms 后发射滚动容器的绝对位置（窗口级锚 'html'），
 *    净位移 <10px 的微动不产步骤。
 *  - 当 input 事件触发时，跳过紧随其后的 mouseover，避免「键入即 hover」噪声。
 *  - mouseover 需在同一元素停留 ≥500ms 才产出 hover（停留门槛）：光标移动路径上划过的元素不记录；
 *    已记录元素的内部微动不重复记录；click/input/离开元素会取消未到时的悬停。
 *  - 1.5s locator 签名去重窗：e.target 引用变了（React 重渲染 / 跨 DOM 树同名 hover）但 selector 不变时，
 *    第二次 hover 不发射——避免一组 hover 步骤里出现连续指向同一文本位置的重复步骤。
 *  - 输入框上 hover 不被发射（hover-when-input 抑制）；checkbox/radio/select/file 及无 value 目标的 input 不产 fill。
 *  - setPaused(true) 期间所有事件被忽略（录制面板「暂停」/元素拾取期间使用）。
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
  /** 停留门槛中的悬停：计时器到时才发射。 */
  private pendingHover: { el: Element; timer: ReturnType<typeof setTimeout> } | null = null;
  /** 最近一次已发射 hover 的元素：其内部微动不再重复记录。 */
  private lastHoverEl: Element | null = null;
  /** 最近一次已发射 hover 的 locator 签名 + 时间戳：
   *  用于在 React 重渲染导致 e.target 引用变化（但 selector 不变）时挡掉重复 hover。
   *  纯 reference 的 `lastHoverEl.contains()` 漏这种情况——同级 hover 文本相同的元素会被当作新目标。 */
  private lastHoverSig: { signature: string; at: number } | null = null;
  private static DEDUP_WINDOW_MS = 200;
  private static HOVER_SUPPRESS_AFTER_INPUT_MS = 300;
  private static HOVER_DWELL_MS = 500;
  private static HOVER_SIG_DEDUP_MS = 1500;
  /** fill 步骤合并窗：连续 input 事件只在用户停顿超过这个时长后才落库。
   *  250ms 是「快速打字停顿」的合理门槛——常见 IMEs / 自动填充以 200-300ms 节奏触发 input，
   *  500ms 太长会让"输完一段等了很久"的中间步骤被吞掉。可通过 options.fillFlushMs 覆盖。 */
  private static FILL_FLUSH_MS_DEFAULT = 250;
  /** aiTask（验证码）合并窗：captcha 输入框在 React 重渲染或后端定时刷新时会反复触发 input，
   *  1.5s 内同 locator 只产一条 aiTask。 */
  private static AITASK_DEDUP_MS = 1500;
  /** 密码自动填充兜底去重窗：Chrome autofill / 1Password 在失焦+focus 反复时可能连续触发 change，
   *  同一 locator 1s 内只产一条 fill,避免重复步骤。 */
  private static SENSITIVE_CHANGE_DEDUP_MS = 1000;
  /** click 发射延迟窗：窗口内来 dblclick 则把挂起的单击升级为双击。需略大于两次 click 间隔
   *  （浏览器 dblclick 判定约 500ms 内），250ms 与 fill 合并窗同量级、交互上无感。 */
  private static CLICK_FLUSH_MS = 250;
  /** scroll 事件流静止判定窗：滚动期间持续重置，静止此时长后才发射最终位置。 */
  private static SCROLL_SETTLE_MS = 350;
  /** scroll 最小净位移（px）：起点到终点的 |Δtop|+|Δleft| 低于此值视为微动噪声不产步骤。 */
  private static SCROLL_MIN_DELTA = 10;
  /** 最近一次敏感字段 change 兜底发射的 locator 签名 + 时间戳:SENSITIVE_CHANGE_DEDUP_MS 窗内去重。 */
  private lastSensitiveChange: { signature: string; at: number } | null = null;

  /** 待 flush 的 fill 步骤：input 事件累加 value，到点才 emit。 */
  private pendingFill: {
    target: HTMLInputElement;
    timer: ReturnType<typeof setTimeout>;
    intentLocator?: ReturnType<typeof buildIntentLocator>;
    /** 挂起序列起点：与 pendingClick/pendingScroll 排序发射，保持用户动作时序。 */
    since: number;
  } | null = null;
  /** 待 flush 的 click 步骤：click 延迟 CLICK_FLUSH_MS 发射，窗口内若来 dblclick 则升级为
   *  clickCount=2（此前双击被压成 1 个 click——element-ui 表格行双击进详情是高频场景）。
   *  sig 是该挂起的 locator 签名：不同目标的新 click 到达时旧挂起先落定，同目标的覆盖
   *  （dblclick 第二击走 dedup return 或覆盖路径，升级语义不变）。 */
  private pendingClick: {
    locs: Locator[];
    sig: string;
    timer: ReturnType<typeof setTimeout>;
    intentLocator?: ReturnType<typeof buildIntentLocator>;
    since: number;
  } | null = null;
  /** 待 flush 的 scroll 步骤：scroll 事件流 debounce，静止 SCROLL_SETTLE_MS 后发射绝对位置。
   *  startTop/startLeft 是本次滚动序列的起点——净位移小于 SCROLL_MIN_DELTA 的微动不产步骤。 */
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
  /** 最近一次 aiTask 步骤的 locator 签名 + 时间戳：1.5s 窗内同签名去重。 */
  private lastAiTaskSig: { signature: string; at: number } | null = null;

  start(handler: StepHandler, options: RecorderOptions = {}) {
    // 幂等：同一副本可能在未 stop 的情况下收到多次 'start'（background 每次 complete 重发 start 广播到所有
    // 存活的副本）。先卸掉旧监听再挂新监听，避免叠加 document 级 capture 监听导致一次点击被捕获多次。
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
    // 先落定挂起的 click / scroll（此刻 handler 还在、canRecord 还为真）：click 在引入延迟窗
    // 之前是同步发射，「点完最后一个动作立即停止录制」从不丢步，这里保持该不变量。
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

  /** 更新录制选项（panel 里切换 hover / fillFlushMs 时调用）。录到一半改也能生效。 */
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

  /** flush 待处理的 fill：用户停打 500ms、blur 失焦、change 触发、或者 stop/start 之间切换时调用。 */
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
    // 净位移过小 / 滚回原位：滚动微动噪声不产步骤。
    const moved = Math.abs(p.top - p.startTop) + Math.abs(p.left - p.startLeft);
    if (moved < RecorderManager.SCROLL_MIN_DELTA) return;
    // 窗口级滚动锚到 scrollingElement（standards 模式恒为 <html>，css 'html' 单候选即可——
    // 回放 evaluate el.scrollTop 即窗口滚动）；元素级滚动用常规候选链。
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

  /** 把挂起的 click / scroll 按各自序列起点时间排序发射（fill 不动——它有自己的 debounce 语义，
   *  由 input/change/blur 入口单独管理）。用于 input 等高频入口，保证 click→input、scroll→input
   *  的步骤顺序不被 pending 窗口打乱。 */
  private flushInteractions() {
    const jobs: Array<{ since: number; run: () => void }> = [];
    if (this.pendingClick) jobs.push({ since: this.pendingClick.since, run: () => this.flushPendingClick() });
    if (this.pendingScroll) jobs.push({ since: this.pendingScroll.since, run: () => this.flushPendingScroll() });
    jobs.sort((a, b) => a.since - b.since);
    for (const j of jobs) j.run();
  }

  /** click + fill + scroll 全部落定（按序列起点排序）。用于 change/keydown/blur 这类
   *  「输入定型」入口和 dblclick 之外的显式交互入口。 */
  private flushAllTransient() {
    this.flushInteractions();
    this.flushPendingFill();
  }

  private flushPendingFill() {
    if (!this.pendingFill) return;
    const { target, intentLocator } = this.pendingFill;
    this.pendingFill = null;
    if (!this.canRecord()) return;
    // React controlled input 在校验失败/错误提示出现时可能整节点 remount：旧节点被 detach，
    // 后续输入都进了新节点。旧节点持有的只是当时的值前缀（如 "a"），发射出去就是碎片 fill。
    // 跳过 detached 目标——新节点的 flush 会带上完整值。
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
    // 页面内控制面板（content/panel.js 注入的 #itest-recorder-panel-host）位于宿主页面 DOM 上，
    // 拖动标题栏、悬停、点按钮都会触发 document 上的 capture 事件。统一在 handler 入口处跳过：
    // 面板的 Shadow DOM 默认 composed=false，e.target 落在 host 上，contains 命中即可。
    const isOnRecorderPanel = (e: Event) => {
      const host = document.getElementById('itest-recorder-panel-host');
      if (!host) return false;
      const path = typeof e.composedPath === 'function' ? e.composedPath() : null;
      if (path && path.includes(host)) return true;
      return host.contains(e.target as Node);
    };

    /** 自身含 role / data-testid / name / 已知交互 class 的元素不属于 layout 容器。其它情况如果父链上
     *  命中至少 1 个稳定语义类（glass-card / auth-form-shell 等），就当作「页面级容器」不记 hover。 */
    function isLayoutContainer(el: Element): boolean {
      if (el.getAttribute('role')) return false;
      if (el.getAttribute('data-testid') || el.getAttribute('data-test-id')) return false;
      if (el.getAttribute('name')) return false;
      // button / a / summary / label 这些「自叶子 UI」不会被用户刻意 hover 到（点击才是它们的语义），
      // 但它们的 hover 一般也不该记——按按钮 hover 多数是光标移动路径上的过渡。让它们继续走到签名
      // 去重（hover 之后通常会 click / input）即可。
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
      // 切到按钮 / 别处点击：flush 当前 input 的累计 fill，否则会丢最后一次停顿前的字符；
      // 挂起中的 click/scroll（快速连续操作）也按序落定，保持步骤时序。
      this.flushAllTransient();
      const target = e.target as Element;
      if (!target) return;
      const locs = generateLocators(target);
      const sig = locs.map((l) => `${l.strategy}:${l.value}`).join('|');
      const now = Date.now();
      if (this.lastClick && this.lastClick.signature === sig && now - this.lastClick.at < RecorderManager.DEDUP_WINDOW_MS) {
        this.lastClick.at = now;
        // 双击/三击的第二击：不重置 pendingClick（等 dblclick 决定升级；
        // dblclick 被页面拦截不来时，timer 到点照常发射单击——比旧版「压成 1 个 click」多救回一次）
        return;
      }
      this.lastClick = { signature: sig, at: now };
      // 不同目标的挂起 click 先落定（250ms 内连点两个不同目标各留一步）；同目标的旧挂起
      // 不 flush——dblclick 升级靠它（>200ms 去重窗的第二击走到这里覆盖旧 pending，
      // dblclick 到达时升级的仍是最新一击，双击总数恒为一条）。
      if (this.pendingClick && this.pendingClick.sig !== sig) this.flushPendingClick();
      // click 延迟 CLICK_FLUSH_MS 发射：窗口内 dblclick 到达即升级为 clickCount=2/3，
      // 否则 timer 到点按单击发射。此前双击被压成 1 个 click，表格行双击进详情这类场景录不出来。
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
      // 常态：双击前必有同目标 click 挂起（第二次 click 走 dedup return）——取走它升级为双击。
      const taken = this.pendingClick;
      this.pendingClick = null;
      if (taken) clearTimeout(taken.timer);
      // 其余挂起（fill/scroll）按序先落定：fill → 双击。
      this.flushPendingFill();
      this.flushPendingScroll();
      this.lastClick = null;
      const detail = (e as MouseEvent).detail ?? 2;
      const clickCount: 2 | 3 = detail >= 3 ? 3 : 2;
      // pendingClick 被提前 flush 走的兜底：用 dblclick 自己的 target 重产候选。
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
    // scroll 事件不冒泡，capture 监听在 document 上可拦截任意元素/文档的滚动。
    // 事件流 debounce：滚动期间持续重置 timer 并更新最终位置，静止 SCROLL_SETTLE_MS 后发射
    // 绝对位置（回放与起点无关）。窗口级滚动（target=document/scrollingElement）锚到 'html'。
    const onScroll = (e: Event) => {
      if (!this.canRecord()) return;
      if (isOnRecorderPanel(e)) return;
      const maybe = e.target as Element | null;
      if (!maybe) return;
      // Document 上没有 scrollTop（元素才有）——以此区分文档级滚动与元素级滚动。
      const se = document.scrollingElement;
      const isWindowScroll = maybe === se || (maybe as { scrollTop?: unknown }).scrollTop === undefined;
      const el = isWindowScroll ? (se ?? document.documentElement) : maybe;
      // 不用 instanceof Element 判别（跨 realm / jsdom 测试下不可靠，同 onChange 的约定）；
      // scroll 事件的 target 只会是元素或 document，窗口分支已锚定 documentElement。
      if (!el.isConnected) return;
      const top = Math.max(0, Math.round(el.scrollTop));
      const left = Math.max(0, Math.round(el.scrollLeft));
      const now = Date.now();
      if (this.pendingScroll && this.pendingScroll.el !== el) {
        // 换容器：旧的先落定（用户滚了两个区域）。
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
      // 挂起中的 click/scroll 先按序落定（click→input 顺序不被 pending 窗口打乱）；
      // fill 不在此 flush——它有自己的 debounce 合并窗。
      this.flushInteractions();
      const target = e.target as HTMLInputElement;
      if (!target) return;
      // select/radio 由 change 产出 select/check 步骤，checkbox 由 change 产出 check，file 由 change 产出 upload；
      // contenteditable 等非表单目标没有 value 属性，也不产 fill。
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
      // 验证码输入框 → aiTask 步骤（回放时 AI 实时识别图片并填入）。
      // 1.5s 窗内同 locator 去重：captcha 在 React 重渲染或后端定时刷新时会反复触发 input，
      // 不去重就会连续产 6+ 条相同 aiTask。
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
      // 普通 input：debounce 合并 + 同 input 累加。切换到另一个 input 时先 flush 旧的。
      // 注意 pendingFill 拿的是 target 引用，flush 窗内它 value 又被改写，flush 时读最新 value 即可。
      if (this.pendingFill && this.pendingFill.target !== target) {
        this.flushPendingFill();
      }
      this.cancelPendingFill();
      const flushMs = this.options.fillFlushMs;
      const timer = setTimeout(() => {
        // 只 flush 当前 timer 仍挂着的 pendingFill：避免输入字符之间 cancelPendingFill 已把 timer 清掉后
        // 又被这个回调捡起来发射残留步骤。
        if (this.pendingFill && this.pendingFill.timer === timer) {
          this.flushPendingFill();
        }
      }, flushMs);
      this.pendingFill = { target, timer, intentLocator: intentLocator ?? undefined, since: Date.now() };
    };
    const onBlur = (e: Event) => {
      // 用户失焦（点别处 / Tab 切走）时强制 flush 当前 fill + 挂起的 click/scroll，
      // 避免 500ms 内就跳转丢失步骤。
      this.flushAllTransient();
    };
    // 输入框内按 Enter 提交（表单无提交按钮 / 用户习惯直接回车）：此前全程无 click 事件，
    // 登录动作整段丢失。keydown 时先 flush 累计 fill（回放顺序 = fill 完整值 → press Enter），
    // 再发射 press 步骤。只录 text 类输入框上的 Enter——button 聚焦时按 Enter 浏览器会派发
    // click，由 onClick 记录，这里再记就重复了。IME 组合期（isComposing / keyCode 229）的
    // Enter 是「确认候选词」不是提交，跳过。
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
    // Chrome 自动填充 / 1Password / LastPass 等密码管理器扩展会直接调 native setter 写 value,
    // **不触发** input 事件,只触发 change 事件(且通常在失焦之后一次性发)。
    // onChange 已 flush pending fill,这里再针对密码输入框补一条「change 但无 pending」路径,
    // 即便用户全程没键盘输入(纯自动填充)也能把 password 值录上。
    // 注意:必须 dedup——同 locator 的 change 可能反复触发(autofill 重填、blur 后再 focus)。
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
      if (!value) return; // 空值不上报(同手动键入前 focus 时的空字符串一致)
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
      // 如果已经有 pending fill 在同一 target 上,250ms 后 flush 会覆盖;这里直接 emit 一次保证
      // 自动填充场景下也立即落库(value 已定型,不需要等 debounce)。
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
      // change 触发意味着用户对当前 input 的输入已经定型（失焦 / Enter / 选择项），flush 全部挂起
      // （fill + click/scroll 按序）。
      this.flushAllTransient();
      onChangePasswordAutofill(e);
      const target = e.target as HTMLInputElement | HTMLSelectElement;
      if (!target) return;
      const now = Date.now();
      // 用 tagName/type 而非 instanceof 判别：后者在跨 realm（jsdom 测试）下不可靠。
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
      // 默认不录 hover：hover 噪声源太多（layout 容器、body/html、重复经过同一元素……），
      // 录到的步骤大半是用户没意图的「我看过这里」。只在调试 / inspector 模式下显式开启。
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
      // body / html 上的 hover 不该记：光标离开所有有意义元素落到空白处时，e.target 会变成 body
      // 或 html，停留计时器照样到点发射 noise 步骤。直接丢弃。tagName 统一 toLowerCase 比较
      // 以兼容 jsdom 返回 'BODY'/'HTML' 大写的情况。
      const rootTag = tag.toLowerCase();
      if (rootTag === 'body' || rootTag === 'html') {
        this.cancelPendingHover();
        return;
      }
      // 页面级 layout 容器 hover 同样不记：`<form>` / `<div class="auth-form-shell">` /
      // `<div class="glass-card project-card">` 这种元素，e.target 通常是它们的空白处或子元素，
      // 没有「hover 到这个容器」的用户意图。判定：自身没有 role / data-testid / name，父链上
      // 至少有 1 个稳定语义类（glass-card / auth-form-shell 等），就视为布局容器丢弃。
      if (isLayoutContainer(target)) {
        this.cancelPendingHover();
        return;
      }
      // 已记录过 hover 的元素内部微动不重复；停留中的元素内部划过不打断计时。
      if (this.lastHoverEl?.contains(target)) return;
      if (this.pendingHover?.el.contains(target)) return;
      // locator 签名级去重：React 重渲染 / 同级 hover 文本相同的元素（e.target 引用变了
      // 但 selector 不变）会被 1.5s 窗口挡掉，避免重复步骤。
      // 仅用 role/testId/text（语义候选）做签名；CSS 路径里 Tailwind utility 容易因重渲染微变，xpath 索引更
      // 会因 DOM 顺序不同而变化，两者都不稳定，不能拿来比较。
      const sig = generateLocators(target)
        .filter((l) => l.strategy === 'role' || l.strategy === 'testId' || l.strategy === 'text')
        .map((l) => `${l.strategy}:${l.value}`)
        .join('|');
      if (this.lastHoverSig && this.lastHoverSig.signature === sig && Date.now() - this.lastHoverSig.at < RecorderManager.HOVER_SIG_DEDUP_MS) return;
      // 光标进入新元素：重置停留计时（移动路径上的元素到不了时门槛）。
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
      // 离开元素（含其祖先）即离开停留目标：取消未到时的悬停（光标移出窗口/空白区时 mouseover 不会再来）。
      const t = e.target as Element;
      if (this.pendingHover && t.contains(this.pendingHover.el)) this.cancelPendingHover();
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('dblclick', onDblClick, true);
    document.addEventListener('scroll', onScroll, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onChange, true);
    // blur 强制 flush fill——避免切走焦点时 500ms 内丢失最后一次输入。
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