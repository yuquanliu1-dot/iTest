import { generateLocators, type Locator } from './selector-core.js';

export interface RecordedStep {
  type: 'click' | 'fill' | 'hover';
  target: Locator[];
  value?: string;
  url: string;
  timestamp: number;
}

type StepHandler = (step: RecordedStep) => void;

/**
 * 浏览器端录制协调器：
 *  - click / input / mouseover 三个事件都被捕获并生成多候选 locator。
 *  - 200ms 内的重复 click 去重（双击是用户意图但不应产生 2 个 click 步骤）。
 *  - 当 input 事件触发时，跳过紧随其后的 mouseover，避免「键入即 hover」噪声。
 *  - 输入框上 hover 不被发射（hover-when-input 抑制）。
 */
export class RecorderManager {
  private active = false;
  private handler: StepHandler | null = null;
  private listeners: Array<{ el: EventTarget; type: string; fn: EventListener }> = [];
  private lastClick: { signature: string; at: number } | null = null;
  private lastInputAt: number | null = null;
  private static DEDUP_WINDOW_MS = 200;
  private static HOVER_SUPPRESS_AFTER_INPUT_MS = 300;

  start(handler: StepHandler) {
    this.active = true;
    this.handler = handler;
    this.lastClick = null;
    this.lastInputAt = null;
    this.attachListeners();
  }

  stop() {
    this.active = false;
    this.handler = null;
    this.detachListeners();
  }

  private attachListeners() {
    const onClick = (e: Event) => {
      const target = e.target as Element;
      if (!target) return;
      const locs = generateLocators(target);
      const sig = locs.map((l) => `${l.strategy}:${l.value}`).join('|');
      const now = Date.now();
      if (this.lastClick && this.lastClick.signature === sig && now - this.lastClick.at < RecorderManager.DEDUP_WINDOW_MS) {
        // 200ms 内同一目标重复点击视为双击，不重复写步骤。
        this.lastClick.at = now;
        return;
      }
      this.lastClick = { signature: sig, at: now };
      this.handler?.({
        type: 'click',
        target: locs,
        url: location.href,
        timestamp: now,
      });
    };
    const onInput = (e: Event) => {
      const target = e.target as HTMLInputElement;
      if (!target) return;
      this.lastInputAt = Date.now();
      this.handler?.({
        type: 'fill',
        target: generateLocators(target),
        value: target.value,
        url: location.href,
        timestamp: Date.now(),
      });
    };
    const onMouseOver = (e: Event) => {
      const target = e.target as Element;
      if (!target) return;
      // hover-when-input 抑制：刚刚输入完，跳过紧随的 hover 噪声。
      const sinceInput = this.lastInputAt !== null ? Date.now() - this.lastInputAt : Infinity;
      if (sinceInput < RecorderManager.HOVER_SUPPRESS_AFTER_INPUT_MS) return;
      // 在表单元素上 hover 也不发：用户聚焦输入而不是悬停。
      const tag = (target.tagName ?? '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      this.handler?.({
        type: 'hover',
        target: generateLocators(target),
        url: location.href,
        timestamp: Date.now(),
      });
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('mouseover', onMouseOver, true);
    this.listeners.push(
      { el: document, type: 'click', fn: onClick },
      { el: document, type: 'input', fn: onInput },
      { el: document, type: 'mouseover', fn: onMouseOver },
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