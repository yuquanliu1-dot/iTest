import { describe, it, expect, vi } from 'vitest';
import type { Page } from 'playwright-core';

// 构造 Page mock：每个 strategy 返回一个独立 locator，便于断言顺序
function makePage(): Page & {
  __calls: string[];
  __locators: Map<string, { __id: string }>;
} {
  const calls: string[] = [];
  const locators = new Map<string, { __id: string }>();
  let counter = 0;
  const id = () => `L${++counter}`;
  const locator = vi.fn((sel: string) => {
    calls.push(`locator(${sel})`);
    const l = { __id: id() };
    locators.set(l.__id, l);
    return l as never;
  });
  const getByText = vi.fn((txt: string) => {
    calls.push(`getByText(${txt})`);
    const l = { __id: id() };
    locators.set(l.__id, l);
    return l as never;
  });
  return {
    locator,
    getByText,
    getByRole: vi.fn(),
    __calls: calls,
    __locators: locators,
  } as never;
}

import { buildCandidates } from '../src/execute/locator-resolver.js';

describe('buildCandidates — priority order', () => {
  it('places intent semanticRole first, then intent contextText', () => {
    const page = makePage();
    buildCandidates(page as never, {
      intentLocator: { semanticRole: 'loginBtn', contextText: '登录' },
      locator: [
        { strategy: 'css', value: '.btn' },
        { strategy: 'xpath', value: '//*[@id="x"]' },
      ],
    });
    expect(page.__calls.slice(0, 3)).toEqual([
      'locator([data-testid="loginBtn"])',
      'getByText(登录)',
      'locator(.btn)', // 普通 CSS 在第一组 css 里（isStableCssPath('.btn') === false）
    ]);
  });

  it('promotes stable #id CSS ahead of XPath', () => {
    const page = makePage();
    buildCandidates(page as never, {
      locator: [
        { strategy: 'css', value: 'div' },
        { strategy: 'css', value: '#submit' }, // 稳定 #id
        { strategy: 'xpath', value: '//*[@id="submit"]' },
      ],
    });
    // #submit 必须出现在 xpath 之前
    const submitIdx = page.__calls.findIndex((c) => c === 'locator(#submit)');
    const xpathIdx = page.__calls.findIndex((c) => c.startsWith('locator(xpath='));
    expect(submitIdx).toBeLessThan(xpathIdx);
    expect(submitIdx).toBeGreaterThanOrEqual(0);
  });

  it('emits no candidates for empty intent + empty locator', () => {
    const page = makePage();
    buildCandidates(page as never, { locator: [] });
    expect(page.__calls).toEqual([]);
  });

  it('keeps order stable across multiple builds (no mutation between runs)', () => {
    const page = makePage();
    const action = {
      intentLocator: { semanticRole: 'x' },
      locator: [{ strategy: 'css', value: '#a' }] as Array<{ strategy: 'css' | 'xpath' | 'role' | 'text' | 'testId'; value: string }>,
    };
    buildCandidates(page as never, action);
    const first = [...page.__calls];
    buildCandidates(page as never, action);
    expect(page.__calls.slice(first.length)).toEqual(first);
  });
});
