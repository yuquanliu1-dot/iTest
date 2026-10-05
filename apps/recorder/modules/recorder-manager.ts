import { generateLocators, type Locator } from './selector-core.js';
import { detectComponent } from './component-detector.js';

export type RecordedStepType = 'click' | 'fill' | 'hover' | 'check' | 'select' | 'upload' | 'solveCaptcha';

export interface RecordedStep {
  type: RecordedStepType;
  target: Locator[];
  /** fill/select 的值；upload 的文件名 */
  value?: string;
  /** solveCaptcha：验证码图片的定位候选（target 是验证码输入框） */
  imageTarget?: Locator[];
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

function buildIntentLocator(el: Element): RecordedStep['intentLocator'] {
  const role = el.getAttribute('data-testid') ?? el.getAttribute('name') ?? null;
  if (!role) return undefined;
  const text = el.textContent?.trim().slice(0, 50) || undefined;
  return text ? { semanticRole: role, contextText: text } : { semanticRole: role };
}

/** 验证码特征：input 自身的 id/name/class/placeholder/aria-label 或关联 label 文案命中即认为是验证码输入框。 */
const CAPTCHA_RE = /captcha|验证码|校验码|validcode|verifycode|vercode|vcode/i;

function isCaptchaInput(el: HTMLInputElement): boolean {
  if (el.type === 'password') return false;
  const labelText = (() => {
    // label[for=id] 或包裹型 label
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

/** 在验证码输入框附近找验证码图片：优先同 form/容器的 img[命中特征]，退回「input 前最近的 img」。 */
function findCaptchaImage(input: HTMLInputElement): HTMLImageElement | null {
  const scope = input.closest('form') ?? input.parentElement;
  if (scope) {
    for (const img of Array.from(scope.querySelectorAll('img'))) {
      const sig = `${img.id} ${img.className} ${img.src} ${img.alt}`;
      if (CAPTCHA_RE.test(sig) && img.offsetWidth > 0) return img;
    }
  }
  let node: Element | null = input;
  while (node) {
    const prev = node.previousElementSibling;
    if (prev) {
      if (prev.tagName === 'IMG' && (prev as HTMLElement).offsetWidth > 0) return prev as HTMLImageElement;
      const img = prev.querySelector?.('img');
      if (img && (img as HTMLElement).offsetWidth > 0) return img as HTMLImageElement;
    }
    node = node.parentElement;
    if (node && (node.tagName === 'FORM' || node === document.body)) break;
  }
  return null;
}

/**
 * 浏览器端录制协调器：
 *  - click / input / change / mouseover 事件被捕获并生成多候选 locator。
 *  - change 细分：checkbox → check（带目标状态），select → select（带选中值），file → upload（只记文件名）。
 *  - 200ms 内的重复 click 去重（双击是用户意图但不应产生 2 个 click 步骤）。
 *  - 当 input 事件触发时，跳过紧随其后的 mouseover，避免「键入即 hover」噪声。
 *  - mouseover 需在同一元素停留 ≥500ms 才产出 hover（停留门槛）：光标移动路径上划过的元素不记录；
 *    已记录元素的内部微动不重复记录；click/input/离开元素会取消未到时的悬停。
 *  - 输入框上 hover 不被发射（hover-when-input 抑制）；checkbox/radio/select/file 及无 value 目标的 input 不产 fill。
 *  - setPaused(true) 期间所有事件被忽略（录制面板「暂停」/元素拾取期间使用）。
 */
export class RecorderManager {
  private active = false;
  private paused = false;
  private handler: StepHandler | null = null;
  private listeners: Array<{ el: EventTarget; type: string; fn: EventListener }> = [];
  private lastClick: { signature: string; at: number } | null = null;
  private lastInputAt: number | null = null;
  /** 停留门槛中的悬停：计时器到时才发射。 */
  private pendingHover: { el: Element; timer: ReturnType<typeof setTimeout> } | null = null;
  /** 最近一次已发射 hover 的元素：其内部微动不再重复记录。 */
  private lastHoverEl: Element | null = null;
  private static DEDUP_WINDOW_MS = 200;
  private static HOVER_SUPPRESS_AFTER_INPUT_MS = 300;
  private static HOVER_DWELL_MS = 500;

  start(handler: StepHandler) {
    this.active = true;
    this.paused = false;
    this.handler = handler;
    this.lastClick = null;
    this.lastInputAt = null;
    this.cancelPendingHover();
    this.lastHoverEl = null;
    this.attachListeners();
  }

  stop() {
    this.active = false;
    this.paused = false;
    this.handler = null;
    this.cancelPendingHover();
    this.lastHoverEl = null;
    this.detachListeners();
  }

  setPaused(paused: boolean) {
    this.paused = paused;
  }

  isPaused() {
    return this.paused;
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

    const onClick = (e: Event) => {
      if (!this.canRecord()) return;
      if (isOnRecorderPanel(e)) return;
      this.cancelPendingHover();
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
      // 验证码输入框 → solveCaptcha 步骤（回放时 AI 识别图片填入,录制值仅作参考不落 DSL）
      if (!isSensitive && isCaptchaInput(target)) {
        const img = findCaptchaImage(target);
        if (img) {
          this.handler?.({
            type: 'solveCaptcha',
            target: generateLocators(target),
            imageTarget: generateLocators(img),
            value,
            url: location.href,
            timestamp: Date.now(),
            ...(intentLocator ? { intentLocator } : {}),
          });
          return;
        }
      }
      this.handler?.({
        type: 'fill',
        target: generateLocators(target),
        value,
        url: location.href,
        timestamp: Date.now(),
        sensitive: isSensitive || undefined,
        ...(intentLocator ? { intentLocator } : {}),
      });
    };
    const onChange = (e: Event) => {
      if (!this.canRecord()) return;
      if (isOnRecorderPanel(e)) return;
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
      // 已记录过 hover 的元素内部微动不重复；停留中的元素内部划过不打断计时。
      if (this.lastHoverEl?.contains(target)) return;
      if (this.pendingHover?.el.contains(target)) return;
      // 光标进入新元素：重置停留计时（移动路径上的元素到不了时门槛）。
      this.cancelPendingHover();
      const el = target;
      const timer = setTimeout(() => {
        this.pendingHover = null;
        if (!this.canRecord()) return;
        this.lastHoverEl = el;
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
    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('mouseleave', onMouseLeave, true);
    this.listeners.push(
      { el: document, type: 'click', fn: onClick },
      { el: document, type: 'input', fn: onInput },
      { el: document, type: 'change', fn: onChange },
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