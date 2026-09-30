import { generateLocators, type Locator } from './selector-core.js';
import { detectComponent, type ComponentInfo } from './component-detector.js';

export interface PickResult {
  locators: Locator[];
  /** 元素可见文本快照（截断 500 字符） */
  text: string;
  /** input/textarea 的当前值，其他元素为空串 */
  inputValue: string;
  tagName: string;
  /** 元素 id / name 属性，用于变量名建议 */
  id: string;
  nameAttr: string;
  /** 静态嗅探到的组件归属，便于录制定位策略选择 */
  componentHint?: ComponentInfo;
}

/**
 * 元素拾取模式：高亮 hover 目标，点击选定，Esc 取消。
 * 使用方（content script）负责在拾取期间暂停普通录制。
 * 取消时回调收到 null；stop() 强制停止（录制终止时）不回调。
 */
export class ElementPicker {
  private active = false;
  private highlighted: HTMLElement | null = null;
  private onMove?: (e: MouseEvent) => void;
  private onClick?: (e: MouseEvent) => void;
  private onKey?: (e: KeyboardEvent) => void;

  private teardown() {
    if (this.onMove) document.removeEventListener('mousemove', this.onMove, true);
    if (this.onClick) document.removeEventListener('click', this.onClick, true);
    if (this.onKey) document.removeEventListener('keydown', this.onKey, true);
    this.onMove = this.onClick = this.onKey = undefined;
    if (this.highlighted) {
      this.highlighted.style.outline = '';
      this.highlighted = null;
    }
    this.active = false;
  }

  start(onDone: (result: PickResult | null) => void): void {
    if (this.active) return;
    this.active = true;

    this.onMove = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el || el === this.highlighted) return;
      if (this.highlighted) this.highlighted.style.outline = '';
      this.highlighted = el;
      el.style.outline = '2px solid #7c3aed';
    };

    this.onClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const el = e.target as HTMLElement;
      const text = (el.innerText ?? el.textContent ?? '').trim().slice(0, 500);
      // 用 tagName 而非 instanceof 判别：后者在跨 realm（jsdom 测试）下不可靠。
      const tag = (el.tagName ?? '').toLowerCase();
      const inputValue =
        tag === 'input' || tag === 'textarea' ? (el as HTMLInputElement).value : '';
      const locators = generateLocators(el);
      const id = el.id ?? '';
      const nameAttr = el.getAttribute('name') ?? '';
      const componentHint = detectComponent(el) ?? undefined;
      this.teardown();
      onDone({ locators, text, inputValue, tagName: el.tagName.toLowerCase(), id, nameAttr, componentHint });
    };

    this.onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      this.teardown();
      onDone(null);
    };

    document.addEventListener('mousemove', this.onMove, true);
    document.addEventListener('click', this.onClick, true);
    document.addEventListener('keydown', this.onKey, true);
  }

  /** 强制停止（录制停止时调用）。未激活时无操作。 */
  stop(): void {
    if (!this.active) return;
    this.teardown();
  }
}
