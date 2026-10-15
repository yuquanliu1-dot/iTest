import { describe, it, expect } from 'vitest';
import type { Page } from 'playwright-core';
import { extractPageElements } from '../src/pi/inspectPage.js';

function fakePage(evaluates: unknown, url = 'http://x/y') {
  return { url: () => url, evaluate: async () => evaluates } as unknown as Page;
}

describe('extractPageElements', () => {
  it('返回 url/title/bodyLen/elements/truncated 快照形状', async () => {
    const snap = await extractPageElements(
      fakePage({ title: '元素管理', bodyLen: 320, elements: ['- button#add "添加" 选择器: #add'], truncated: true }),
      'http://192.168.30.228:8088/element-manager',
    );
    expect(snap.url).toBe('http://192.168.30.228:8088/element-manager');
    expect(snap.title).toBe('元素管理');
    expect(snap.bodyLen).toBe(320);
    expect(snap.elements).toEqual(['- button#add "添加" 选择器: #add']);
    expect(snap.truncated).toBe(true);
  });
});
