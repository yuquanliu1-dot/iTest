import { generateLocators, type Locator } from './selector-core.js';
import { detectComponent, type ComponentInfo } from './component-detector.js';

export interface PickResult {
  locators: Locator[];
  /** Snapshot of the element's visible text (truncated at 500 characters) */
  text: string;
  /** Current value of input/textarea; empty string for other elements */
  inputValue: string;
  tagName: string;
  /** Element id / name attributes, used for variable name suggestions */
  id: string;
  nameAttr: string;
  /** Component ownership sniffed statically, informing the recording locator strategy */
  componentHint?: ComponentInfo;
}

/**
 * Element pick mode: highlights the hovered target, click to select, Esc to cancel.
 * The consumer (content script) is responsible for pausing normal recording during the pick.
 * The cancel callback receives null; stop() force-stops (recording terminated) without invoking the callback.
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
      el.style.outline = '2px solid #7C5CFC';
    };

    this.onClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const el = e.target as HTMLElement;
      const text = (el.innerText ?? el.textContent ?? '').trim().slice(0, 500);
      // Discriminate by tagName rather than instanceof: the latter is unreliable across realms (jsdom tests).
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

  /** Force stop (called when recording stops). No-op when not active. */
  stop(): void {
    if (!this.active) return;
    this.teardown();
  }
}
