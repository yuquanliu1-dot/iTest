import { generateLocators, deriveSemantic, type Locator } from './selector-core.js';
import { detectComponent } from './component-detector.js';

/** 录制选项：popup / panel 配置后通过 start({...}) 传入。空 options 等价于历史默认行为。 */
export interface RecorderOptions {
  /** 优先 data-* 属性名（finder 会把整条父链的 `[name=...]` 都用上）。默认 `data-testid`。 */
  preferredDataAttribute?: string;
  /** 是否录 hover 步骤。默认 false——hover 是最大的噪声源之一，调试时再开。 */
  recordHover?: boolean;
  /** fill debounce 合并窗（ms）。用户连续输入超过这个时长才落库。默认 500。 */
  fillFlushMs?: number;
}

export type RecordedStepType = 'click' | 'fill' | 'hover' | 'check' | 'select' | 'upload' | 'aiTask';

export interface RecordedStep {
  type: RecordedStepType;
  target: Locator[];
  /** fill/select 的值；upload 的文件名 */
  value?: string;
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
 *  - click / input / change / mouseover 事件被捕获并生成多候选 locator。
 *  - change 细分：checkbox → check（带目标状态），select → select（带选中值），file → upload（只记文件名）。
 *  - 200ms 内的重复 click 去重（双击是用户意图但不应产生 2 个 click 步骤）。
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

  /** 待 flush 的 fill 步骤：input 事件累加 value，到点才 emit。 */
  private pendingFill: {
    target: HTMLInputElement;
    timer: ReturnType<typeof setTimeout>;
    intentLocator?: ReturnType<typeof buildIntentLocator>;
  } | null = null;
  /** 最近一次 aiTask 步骤的 locator 签名 + 时间戳：1.5s 窗内同签名去重。 */
  private lastAiTaskSig: { signature: string; at: number } | null = null;

  start(handler: StepHandler, options: RecorderOptions = {}) {
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
    this.lastAiTaskSig = null;
    this.attachListeners();
  }

  stop() {
    this.active = false;
    this.paused = false;
    this.handler = null;
    this.cancelPendingHover();
    this.cancelPendingFill();
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
      // 切到按钮 / 别处点击：flush 当前 input 的累计 fill，否则会丢最后一次停顿前的字符。
      this.flushPendingFill();
      const target = e.target as Element;
      if (!target) return;
      const locs = generateLocators(target);
      const sig = locs.map((l) => `${l.strategy}:${l.value}`).join('|');
      const now = Date.now();
      if (this.lastClick && this.lastClick.signature === sig && now - this.lastClick.at < RecorderManager.DEDUP_WINDOW_MS) {
        this.lastClick.at = now;
        return;
      }
      this.lastClick = { signature: sig, at: now };
      const intentLocator = buildIntentLocator(target);
      this.handler?.({
        type: 'click',
        target: locs,
        url: location.href,
        timestamp: now,
        ...(intentLocator ? { intentLocator } : {}),
      });
    };
    const onInput = (e: Event) => {
      if (!this.canRecord()) return;
      if (isOnRecorderPanel(e)) return;
      this.cancelPendingHover();
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
      this.pendingFill = { target, timer, intentLocator: intentLocator ?? undefined };
    };
    const onBlur = (e: Event) => {
      // 用户失焦（点别处 / Tab 切走）时强制 flush 当前 fill，避免 500ms 内就跳转丢失步骤。
      this.flushPendingFill();
    };
    const onChange = (e: Event) => {
      if (!this.canRecord()) return;
      if (isOnRecorderPanel(e)) return;
      // change 触发意味着用户对当前 input 的输入已经定型（失焦 / Enter / 选择项），先 flush 累计的 fill。
      this.flushPendingFill();
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
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onChange, true);
    // blur 强制 flush fill——避免切走焦点时 500ms 内丢失最后一次输入。
    document.addEventListener('focusout', onBlur, true);
    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('mouseleave', onMouseLeave, true);
    this.listeners.push(
      { el: document, type: 'click', fn: onClick },
      { el: document, type: 'input', fn: onInput },
      { el: document, type: 'change', fn: onChange },
      { el: document, type: 'focusout', fn: onBlur },
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