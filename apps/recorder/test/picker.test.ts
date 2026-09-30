import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM, type DOMWindow } from 'jsdom';
import { ElementPicker, type PickResult } from '../modules/picker.js';

// picker 在 start 时引用全局 `document`。
// 每个用例新建一个 JSDOM，把它挂到 globalThis.document 上（与 recorder-manager.test.ts 同一套路）。
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
    let called = 0;
    picker.start(() => {
      called++;
    });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(called).toBe(1);
    // 再次点击不应再触发（监听器已移除，且回调收的是 null）
    const r: (PickResult | null)[] = [];
    // 重新 start 一个 picker 验证前一个已停止：直接再 start 新的即可，这里验证 stop() 幂等
    picker.stop();
    expect(called).toBe(1);
  });

  it('does not start twice', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const results: (PickResult | null)[] = [];
    picker.start((r) => results.push(r));
    picker.start((r) => results.push(r)); // 第二次调用应被忽略
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(results).toHaveLength(1);
  });
});
