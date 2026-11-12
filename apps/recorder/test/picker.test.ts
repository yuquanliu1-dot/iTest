import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM, type DOMWindow } from 'jsdom';
import { ElementPicker, type PickResult } from '../modules/picker.js';

// picker references the global `document` at start time.
// Each case builds a fresh JSDOM and attaches it to globalThis.document (same approach as recorder-manager.test.ts).
let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  (globalThis as { document: Document }).document = dom.window.document;
  (globalThis as unknown as { window: DOMWindow }).window = dom.window;
});

describe('ElementPicker', () => {
  let picker: ElementPicker;

  beforeEach(() => {
    document.body.innerHTML = '';
    picker = new ElementPicker();
  });

  it('click returns locators and text snapshot', () => {
    const btn = document.createElement('button');
    btn.textContent = '提交订单';
    document.body.appendChild(btn);
    let result: PickResult | null = null;
    picker.start((r) => {
      result = r;
    });
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(result).not.toBeNull();
    expect(result!.text).toBe('提交订单');
    expect(result!.locators.length).toBeGreaterThan(0);
    expect(result!.locators[0]!.strategy).toBe('role');
  });

  it('input element reports its value as inputValue', () => {
    const input = document.createElement('input');
    input.value = 'A-123';
    document.body.appendChild(input);
    let result: PickResult | null = null;
    picker.start((r) => {
      result = r;
    });
    input.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(result!.inputValue).toBe('A-123');
    expect(result!.tagName).toBe('input');
  });

  it('Escape cancels with null and cleans up listeners', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const received: (PickResult | null)[] = [];
    picker.start((r) => received.push(r));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(received).toHaveLength(1);
    expect(received[0]).toBeNull();
    // Listeners already removed: clicking again after Esc must not trigger another callback
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(received).toHaveLength(1);
    // stop() is idempotent
    picker.stop();
    expect(received).toHaveLength(1);
  });

  it('does not start twice', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const results: (PickResult | null)[] = [];
    picker.start((r) => results.push(r));
    picker.start((r) => results.push(r)); // the second call should be ignored
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(results).toHaveLength(1);
  });

  it('returns componentHint when picking inside antd select container', () => {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<span class="ant-select-selection">click</span>';
    document.body.appendChild(wrap);
    const target = wrap.querySelector('.ant-select-selection')!;
    let result: PickResult | null = null;
    picker.start((r) => {
      result = r;
    });
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(result).not.toBeNull();
    expect(result!.componentHint).toBeDefined();
    expect(result!.componentHint!.lib).toBe('antd');
    wrap.remove();
  });
});
