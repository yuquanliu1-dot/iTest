import { generateLocators, type Locator } from './selector-core.js';

export type RecordedStepType = 'click' | 'fill' | 'hover' | 'check' | 'select' | 'upload';

export interface RecordedStep {
  type: RecordedStepType;
  target: Locator[];
  /** fill/select 的值；upload 的文件名 */
  value?: string;
  /** check 的目标状态 */
  checked?: boolean;
  url: string;
  timestamp: number;
}

type StepHandler = (step: RecordedStep) => void;

/**
 * 浏览器端录制协调器：
 *  - click / input / change / mouseover 事件被捕获并生成多候选 locator。
 *  - change 细分：checkbox → check（带目标状态），select → select（带选中值），file → upload（只记文件名）。
 *  - 200ms 内的重复 click 去重（双击是用户意图但不应产生 2 个 click 步骤）。
 *  - 当 input 事件触发时，跳过紧随其后的 mouseover，避免「键入即 hover」噪声。
 *  - 输入框上 hover 不被发射（hover-when-input 抑制）；checkbox/file 的 input 不产 fill。
 *  - setPaused(true) 期间所有事件被忽略（录制面板「暂停」/元素拾取期间使用）。
 */
export class RecorderManager {
  private active = false;
  private paused = false;
  private handler: StepHandler | null = null;
  private listeners: Array<{ el: EventTarget; type: string; fn: EventListener }> = [];
  private lastClick: { signature: string; at: number } | null = null;
  private lastInputAt: number | null = null;
  private static DEDUP_WINDOW_MS = 200;
  private static HOVER_SUPPRESS_AFTER_INPUT_MS = 300;

  start(handler: StepHandler) {
    this.active = true;
    this.paused = false;
    this.handler = handler;
    this.lastClick = null;
    this.lastInputAt = null;
    this.attachListeners();
  }

  stop() {
    this.active = false;
    this.paused = false;
    this.handler = null;
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

  private attachListeners() {
    const onClick = (e: Event) => {
      if (!this.canRecord()) return;
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
      this.handler?.({
        type: 'click',
        target: locs,
        url: location.href,
        timestamp: now,
      });
    };
    const onInput = (e: Event) => {
      if (!this.canRecord()) return;
      const target = e.target as HTMLInputElement;
      if (!target) return;
      // checkbox 由 change 事件产出 check 步骤；file 由 change 产出 upload 步骤。
      if (target.type === 'checkbox' || target.type === 'file') return;
      this.lastInputAt = Date.now();
      this.handler?.({
        type: 'fill',
        target: generateLocators(target),
        value: target.value,
        url: location.href,
        timestamp: Date.now(),
      });
    };
    const onChange = (e: Event) => {
      if (!this.canRecord()) return;
      const target = e.target as HTMLInputElement | HTMLSelectElement;
      if (!target) return;
      const now = Date.now();
      // 用 tagName/type 而非 instanceof 判别：后者在跨 realm（jsdom 测试）下不可靠。
      const tag = (target.tagName ?? '').toLowerCase();
      if (tag === 'input') {
        const t = (target as HTMLInputElement).type;
        if (t === 'checkbox') {
          this.handler?.({
            type: 'check',
            target: generateLocators(target),
            checked: (target as HTMLInputElement).checked,
            url: location.href,
            timestamp: now,
          });
          return;
        }
        if (t === 'file') {
          const files = (target as HTMLInputElement).files;
          this.handler?.({
            type: 'upload',
            target: generateLocators(target),
            value: files?.[0]?.name ?? '',
            url: location.href,
            timestamp: now,
          });
        }
        return;
      }
      if (tag === 'select') {
        this.handler?.({
          type: 'select',
          target: generateLocators(target),
          value: target.value,
          url: location.href,
          timestamp: now,
        });
      }
    };
    const onMouseOver = (e: Event) => {
      if (!this.canRecord()) return;
      const target = e.target as Element;
      if (!target) return;
      const sinceInput = this.lastInputAt !== null ? Date.now() - this.lastInputAt : Infinity;
      if (sinceInput < RecorderManager.HOVER_SUPPRESS_AFTER_INPUT_MS) return;
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
    document.addEventListener('change', onChange, true);
    document.addEventListener('mouseover', onMouseOver, true);
    this.listeners.push(
      { el: document, type: 'click', fn: onClick },
      { el: document, type: 'input', fn: onInput },
      { el: document, type: 'change', fn: onChange },
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