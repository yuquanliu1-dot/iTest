import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { generateLocators } from '../modules/selector-core.js';

let document: Document;

beforeEach(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  document = dom.window.document;
});

function makeEl(html: string): Element {
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  return wrap.firstElementChild!;
}

describe('selector-core', () => {
  it('generates role locator for button with aria-label', () => {
    const el = makeEl('<button aria-label="提交">ok</button>');
    const locs = generateLocators(el);
    expect(locs.find((l) => l.strategy === 'role')?.value).toBe('button[name="提交"]');
  });

  it('generates testId locator when data-testid is present', () => {
    const el = makeEl('<button data-testid="submit">ok</button>');
    const locs = generateLocators(el);
    expect(locs.find((l) => l.strategy === 'testId')?.value).toBe('submit');
  });

  it('generates css locator with tag', () => {
    const el = makeEl('<button>ok</button>');
    const locs = generateLocators(el);
    expect(locs.find((l) => l.strategy === 'css')?.value).toContain('button');
  });

  it('generates xpath locator with // prefix', () => {
    const el = makeEl('<button>ok</button>');
    const locs = generateLocators(el);
    expect(locs.find((l) => l.strategy === 'xpath')?.value).toMatch(/^\/.*button/);
  });

  it('limits to 5 candidates', () => {
    const el = makeEl('<button data-testid="x" aria-label="y">z</button>');
    const locs = generateLocators(el);
    expect(locs.length).toBeLessThanOrEqual(5);
  });

  it('includes text locator when text is short', () => {
    const el = makeEl('<a>登录</a>');
    const locs = generateLocators(el);
    expect(locs.find((l) => l.strategy === 'text')?.value).toBe('登录');
  });

  it('filters runtime id hash from css locator', () => {
    const el = makeEl('<button id="login-7f9c3a">x</button>');
    const locs = generateLocators(el);
    const css = locs.find((l) => l.strategy === 'css')!;
    expect(css.value).not.toContain('login-7f9c3a');
  });

  it('strips state class active from css locator', () => {
    const el = makeEl('<button class="btn primary active">x</button>');
    const locs = generateLocators(el);
    const css = locs.find((l) => l.strategy === 'css')!.value;
    expect(css).not.toMatch(/active/);
  });
});