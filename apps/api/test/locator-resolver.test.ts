import { describe, it, expect, vi } from 'vitest';
import type { Page } from 'playwright-core';

// Builds a Page mock: each strategy returns an independent locator, so order is easy to assert
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
      'locator(.btn)', // plain CSS sits in the first css group (isStableCssPath('.btn') === false)
    ]);
  });

  it('promotes stable #id CSS ahead of XPath', () => {
    const page = makePage();
    buildCandidates(page as never, {
      locator: [
        { strategy: 'css', value: 'div' },
        { strategy: 'css', value: '#submit' }, // stable #id
        { strategy: 'xpath', value: '//*[@id="submit"]' },
      ],
    });
    // #submit must appear before xpath
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
