import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Page } from 'playwright-core';
import { recordConsoleEvent, recordPageError, createConsoleCapture, drainConsoleForPage, type ConsoleBuffer } from './consoleCapture.js';

function fakePage(): { page: Page; ee: EventEmitter } {
  const ee = new EventEmitter();
  return { page: ee as unknown as Page, ee };
}

describe('recordConsoleEvent', () => {
  it('只留 error 级 console 输出', () => {
    const buf: ConsoleBuffer = [];
    recordConsoleEvent(buf, 'log', 'noise', 1);
    recordConsoleEvent(buf, 'info', 'noise', 2);
    recordConsoleEvent(buf, 'warning', 'noise', 3);
    recordConsoleEvent(buf, 'error', 'boom', 4);
    expect(buf).toEqual([{ type: 'console-error', text: 'boom', ts: 4 }]);
  });

  it('文本超长截断到 500 字符', () => {
    const buf: ConsoleBuffer = [];
    recordConsoleEvent(buf, 'error', 'x'.repeat(600), 1);
    expect(buf[0]!.text.length).toBe(501); // 500 + the ellipsis
    expect(buf[0]!.text.endsWith('…')).toBe(true);
  });

  it('超过单步上限后丢弃后来的条目', () => {
    const buf: ConsoleBuffer = [];
    for (let i = 0; i < 12; i++) recordConsoleEvent(buf, 'error', `e${i}`, i);
    expect(buf.length).toBe(10);
    expect(buf[0]!.text).toBe('e0');
    expect(buf.at(-1)!.text).toBe('e9');
  });
});

describe('recordPageError', () => {
  it('Error 取 message，非 Error String 化', () => {
    const buf: ConsoleBuffer = [];
    recordPageError(buf, new TypeError('a is not a function'), 1);
    recordPageError(buf, 'raw string throw', 2);
    expect(buf[0]).toEqual({ type: 'pageerror', text: 'a is not a function', ts: 1 });
    expect(buf[1]).toEqual({ type: 'pageerror', text: 'raw string throw', ts: 2 });
  });

  it('与 console 条目共享同一个上限', () => {
    const buf: ConsoleBuffer = [];
    for (let i = 0; i < 9; i++) recordConsoleEvent(buf, 'error', `c${i}`, i);
    recordPageError(buf, new Error('uncaught'), 99);
    expect(buf.length).toBe(10);
    expect(buf.at(-1)!.type).toBe('pageerror');
    recordPageError(buf, new Error('dropped'), 100);
    expect(buf.length).toBe(10);
  });
});

describe('createConsoleCapture / drainConsoleForPage', () => {
  it('drain 取走并清空，再次 drain 为空', () => {
    const { page, ee } = fakePage();
    const capture = createConsoleCapture(page);
    ee.emit('console', { type: () => 'error', text: () => 'boom' });
    ee.emit('pageerror', new Error('uncaught'));
    ee.emit('console', { type: () => 'log', text: () => 'noise' });
    const first = capture.drain();
    expect(first.map((e) => e.type)).toEqual(['console-error', 'pageerror']);
    expect(capture.drain()).toEqual([]);
  });

  it('同页重复 createConsoleCapture 返回同一实例（幂等）', () => {
    const { page, ee } = fakePage();
    const a = createConsoleCapture(page);
    const b = createConsoleCapture(page);
    expect(a).toBe(b);
    ee.emit('console', { type: () => 'error', text: () => 'once' });
    expect(a.drain().length).toBe(1);
    expect(b.drain().length).toBe(0);
  });

  it('没有采集器的页 drainConsoleForPage 返回空数组', () => {
    expect(drainConsoleForPage(fakePage().page)).toEqual([]);
  });

  it('drainConsoleForPage 走 WeakMap 取到采集数据', () => {
    const { page, ee } = fakePage();
    createConsoleCapture(page);
    ee.emit('console', { type: () => 'error', text: () => 'via-map' });
    expect(drainConsoleForPage(page).map((e) => e.text)).toEqual(['via-map']);
    expect(drainConsoleForPage(page)).toEqual([]);
  });
});
