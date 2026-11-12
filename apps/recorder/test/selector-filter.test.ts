import { describe, it, expect } from 'vitest';
import { isStableCssPath, filterCssPath, stripRuntimeAria, isUtilityClass, hasUnstableClass, isTransientStateClass } from '../modules/selector-filter.js';

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
    // Keep the fragment even when only the tag remains (do not delete the whole button#login-7f9c3a segment).
    expect(filterCssPath('button#login-7f9c3a')).toBe('button');
    expect(filterCssPath('div#__BV_btn_24.ivu-btn-large')).toBe('div.ivu-btn-large');
    expect(filterCssPath('input#root-abc123.form-control')).toBe('input.form-control');
    // Stable ids must not be stripped.
    expect(filterCssPath('button#login')).toBe('button#login');
    // Radix runtime short ids (hex shorter than 6 chars) must be stripped too.
    expect(filterCssPath('div#radix-:r37:.glass-panel')).toBe('div.glass-panel');
    expect(filterCssPath('div#radix-:r1ab:')).toBe('div');
  });
  it('filters numeric-only classes (Tailwind arbitrary value residue)', () => {
    // Tailwind v4 merged classes like `col-5` / `basis-3` occasionally leave a digits-only class behind, zero semantics.
    expect(filterCssPath('div.5.shrink-0')).toBe('div.shrink-0');
    expect(hasUnstableClass('div.5')).toBe(true);
    expect(hasUnstableClass('div.shrink-0')).toBe(false);
  });
  it('filters Radix data-[state] attributes kept as class by buildCssPath', () => {
    // buildCssPath keeps the entire className segment (including `data-[state=open]:animate-in`) as a class segment;
    // these state values change on every toggle, so they must be dropped as STATE. Note: after flat splitting,
    // `data-[state=open]:animate-in` becomes two tokens — `.data-` (a plain class segment) and
    // `[state=open]:animate-in` (an attribute-selector segment); if either matches STATE_ATTR_RE, drop it.
    expect(hasUnstableClass('div.data-[state=open]:animate-in')).toBe(true);
    expect(hasUnstableClass('div.[state=open]:animate-in')).toBe(true);
    expect(filterCssPath('div.data-[state=open]:animate-in.data-[state=closed]:fade-out-0'))
      .toBe('div');
  });
  it('filters Tailwind arbitrary values (text-[14px] / w-[1rem] / bg-[#7c5cfc])', () => {
    expect(isUtilityClass('text-[14px]')).toBe(true);
    expect(isUtilityClass('w-[1rem]')).toBe(true);
    expect(isUtilityClass('bg-[#7c5cfc]')).toBe(true);
    expect(isUtilityClass('mt-[-2px]')).toBe(true);
    expect(filterCssPath('button.btn-primary.text-[14px].mt-5'))
      .toBe('button.btn-primary');
  });
  it('filters Tailwind variant prefixes (hover: / disabled: / md: / dark: / group-hover:)', () => {
    expect(isUtilityClass('hover:bg-blue-500')).toBe(true);
    expect(isUtilityClass('disabled:cursor-not-allowed')).toBe(true);
    expect(isUtilityClass('disabled:opacity-50')).toBe(true);
    expect(isUtilityClass('md:flex-row')).toBe(true);
    expect(isUtilityClass('dark:bg-zinc-900')).toBe(true);
    expect(isUtilityClass('group-hover:opacity-100')).toBe(true);
    expect(filterCssPath('button.btn-primary.disabled:cursor-not-allowed.disabled:opacity-50'))
      .toBe('button.btn-primary');
    // md:flex-row / auth-page-enter on the form container are stripped down to only the stable container class
    expect(filterCssPath('div.md:flex-row.auth-page-enter.div.glass-card'))
      .toContain('glass-card');
    expect(filterCssPath('div.md:flex-row.auth-page-enter.div.glass-card'))
      .not.toContain('md:flex-row');
  });
});

describe('transient interaction-state classes（悬停/聚焦瞬态）', () => {
  // Regression motive: the 规则查看 case replayed count=0 — at recording time the hovered row carried Element-UI .hover-row,
  // which cannot exist at replay without a mouse hover.
  it('isTransientStateClass: hover-row / current-row / is-hover / 后缀族', () => {
    expect(isTransientStateClass('hover-row')).toBe(true);
    expect(isTransientStateClass('current-row')).toBe(true);
    expect(isTransientStateClass('is-hover')).toBe(true);
    expect(isTransientStateClass('is-active')).toBe(true);
    expect(isTransientStateClass('cell-hover')).toBe(true);
    expect(isTransientStateClass('ant-table-cell-row-hover')).toBe(true);
    expect(isTransientStateClass('tab-active')).toBe(true);
    // Stable structural classes must not be hit
    expect(isTransientStateClass('el-table__row')).toBe(false);
    expect(isTransientStateClass('icon-chakan')).toBe(false);
    expect(isTransientStateClass('btn-primary')).toBe(false);
    expect(isTransientStateClass('glass-card')).toBe(false);
  });
  it('hasUnstableClass flags hover-row paths', () => {
    expect(hasUnstableClass('tr.el-table__row.hover-row > td > .icon-chakan')).toBe(true);
    expect(hasUnstableClass('tr.el-table__row > td > .icon-chakan')).toBe(false);
  });
  it('filterCssPath strips hover-row but keeps the rest of the chain', () => {
    // Input contract: child-combinator paths joined by ' > ' (the output form of finder / buildCssPathFallback).
    expect(filterCssPath('table > tr.el-table__row.hover-row > td > .icon-chakan'))
      .toBe('table > tr.el-table__row > td > .icon-chakan');
    expect(filterCssPath('tr.is-hover > td')).toBe('tr > td');
    expect(filterCssPath('li.el-menu-item.is-active')).toBe('li.el-menu-item');
    expect(filterCssPath('tr.current-row > td')).toBe('tr > td');
  });
});

describe('Element-UI 运行时位置类（资产管理-资产编辑 用例回归）', () => {
  // Regression motive: step 4 of run eed6450e asserted the sole candidate .has-gutter .el-table_1_column_4 > .cell,
  // which replayed count=0 — el-table_{instance}_column_{column order} is the component creation/column registration
  // order and drifts as soon as cross-session rendering changes; has-gutter only renders with a horizontal scrollbar.
  // Both are in the same family as hover-row: present at recording time, not dependable at replay.
  it('isTransientStateClass: el-table_{n}[_column_{n}] 与 has-gutter', () => {
    expect(isTransientStateClass('el-table_1')).toBe(true);
    expect(isTransientStateClass('el-table_1_column_4')).toBe(true);
    expect(isTransientStateClass('el-table_12_column_34')).toBe(true);
    expect(isTransientStateClass('has-gutter')).toBe(true);
    // BEM stable structural classes must not be hit (no _<digits> suffix)
    expect(isTransientStateClass('el-table__row')).toBe(false);
    expect(isTransientStateClass('el-table__header-wrapper')).toBe(false);
    expect(isTransientStateClass('el-table__fixed-right')).toBe(false);
    // Numeric suffixes not starting with el-table must not be hit
    expect(isTransientStateClass('icon-chakan')).toBe(false);
    expect(isTransientStateClass('glass-card')).toBe(false);
  });
  it('hasUnstableClass flags runtime positional paths', () => {
    expect(hasUnstableClass('tr.has-gutter > th.el-table_1_column_4 > div.cell')).toBe(true);
    expect(hasUnstableClass('th.is-sortable > div.cell')).toBe(false);
  });
  it('filterCssPath strips runtime positional / gutter but keeps tags and stable classes', () => {
    expect(filterCssPath('div.el-table__header-wrapper > table > tr.has-gutter > th.el-table_1_column_4.is-sortable > div.cell'))
      .toBe('div.el-table__header-wrapper > table > tr > th.is-sortable > div.cell');
    expect(filterCssPath('div.el-table_1 > div.cell')).toBe('div > div.cell'); // runtime shell stripped, tag kept
  });
});

describe('isUtilityClass (Tailwind strip)', () => {
  it('detects plain Tailwind utilities', () => {
    expect(isUtilityClass('flex')).toBe(true);
    expect(isUtilityClass('w-full')).toBe(true);
    expect(isUtilityClass('h-dvh')).toBe(true);
    expect(isUtilityClass('overflow-hidden')).toBe(true);
    expect(isUtilityClass('items-center')).toBe(true);
    // Any Tailwind prefix + dash-token is recognized (colon modifiers like hover:bg-blue-500 don't match here —
    // they were already stripped during Tailwind prefix parsing. The brackets/slashes of `text-[12px]` / `w-1/2`
    // are not legal JS class tokens; what the browser receives is a valid CSS literal generated by the browser,
    // and the Tailwind compiler strips them into stable tokens. Our detection only acts on stable tokens;
    // recording strategy is unaffected.
  });
  it('keeps iDO semantic classes even when they look like utilities', () => {
    expect(isUtilityClass('glass-card')).toBe(false);
    expect(isUtilityClass('project-card')).toBe(false);
    expect(isUtilityClass('group-nav-tile')).toBe(false);
    expect(isUtilityClass('main-content')).toBe(false);
    expect(isUtilityClass('group')).toBe(false);
  });
  it('keeps unrecognized project classes', () => {
    expect(isUtilityClass('my-component')).toBe(false);
    expect(isUtilityClass('LoginForm')).toBe(false); // uppercase doesn't match (the regex anchor is a lowercase prefix)
    expect(isUtilityClass('foo-bar')).toBe(false);
  });
  it('filterCssPath strips utilities but keeps semantic class', () => {
    expect(filterCssPath('button.group-nav-tile.w-full.flex.items-center.justify-center'))
      .toBe('button.group-nav-tile');
    // `group` is in SEMANTIC_KEEP (iDO semantics), not stripped.
    expect(filterCssPath('div.glass-card.project-card.cursor-pointer.group'))
      .toBe('div.glass-card.project-card.group');
    // After utility stripping the segment is left with only the `div` tag (same behavior as runtime ids: tag kept, classes stripped out).
    expect(filterCssPath('body > div#root > div.flex.h-dvh.overflow-hidden > nav.glass-panel'))
      .toBe('body > div#root > div > nav.glass-panel');
  });
  it('hasUnstableClass flags utility-laden paths', () => {
    expect(hasUnstableClass('body.flex.h-dvh')).toBe(true);
    expect(hasUnstableClass('button.w-full')).toBe(true);
    // Pure semantic-class path is stable
    expect(hasUnstableClass('button.group-nav-tile')).toBe(false);
  });
});