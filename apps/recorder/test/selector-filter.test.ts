import { describe, it, expect } from 'vitest';
import { isStableCssPath, filterCssPath, stripRuntimeAria } from '../modules/selector-filter.js';

describe('selector-filter', () => {
  it('marks id with hex suffix as unstable', () => {
    expect(isStableCssPath('div#root-7f9c3a')).toBe(false);
    expect(isStableCssPath('div#root')).toBe(true);
  });
  it('filters out __BV_ and ivu- ids', () => {
    expect(isStableCssPath('div#__BV_btn_24')).toBe(false);
    expect(isStableCssPath('div#ivu-123abc')).toBe(false);
  });
  it('filters state classes from css tokens', () => {
    const out = filterCssPath('button.btn.btn-primary.active');
    expect(out).not.toMatch(/active/);
    expect(out).toMatch(/btn-primary/);
  });
  it('stripRuntimeAria removes aria-controls / aria-describedby / aria-activedescendant', () => {
    expect(stripRuntimeAria('button[aria-controls="m1"][aria-label="x"]')).toBe('button[aria-label="x"]');
  });
  it('keeps css path non-empty after filtering', () => {
    const out = filterCssPath('button.active');
    expect(out.length).toBeGreaterThan(0);
  });
  it('filterCssPath strips runtime id segments but preserves tag and stable class', () => {
    // 整段只剩 tag 时仍保留片段（不要把 button#login-7f9c3a 整段删掉）。
    expect(filterCssPath('button#login-7f9c3a')).toBe('button');
    expect(filterCssPath('div#__BV_btn_24.ivu-btn-large')).toBe('div.ivu-btn-large');
    expect(filterCssPath('input#root-abc123.form-control')).toBe('input.form-control');
    // 稳定 id 不应被误删。
    expect(filterCssPath('button#login')).toBe('button#login');
  });
});