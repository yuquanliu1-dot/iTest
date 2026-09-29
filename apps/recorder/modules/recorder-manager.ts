import { generateLocators, type Locator } from './selector-core.js';

export interface RecordedStep {
  type: 'click' | 'fill' | 'hover';
  target: Locator[];
  value?: string;
  url: string;
  timestamp: number;
}

type StepHandler = (step: RecordedStep) => void;

export class RecorderManager {
  private active = false;
  private handler: StepHandler | null = null;
  private listeners: Array<{ el: EventTarget; type: string; fn: EventListener }> = [];

  start(handler: StepHandler) {
    this.active = true;
    this.handler = handler;
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
      this.handler?.({
        type: 'click',
        target: generateLocators(target),
        url: location.href,
        timestamp: Date.now(),
      });
    };
    const onInput = (e: Event) => {
      const target = e.target as HTMLInputElement;
      if (!target) return;
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