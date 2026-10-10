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
    // 整段只剩 tag 时仍保留片段（不要把 button#login-7f9c3a 整段删掉）。
    expect(filterCssPath('button#login-7f9c3a')).toBe('button');
    expect(filterCssPath('div#__BV_btn_24.ivu-btn-large')).toBe('div.ivu-btn-large');
    expect(filterCssPath('input#root-abc123.form-control')).toBe('input.form-control');
    // 稳定 id 不应被误删。
    expect(filterCssPath('button#login')).toBe('button#login');
    // Radix 运行时短 id（hex 不够 6 位）也要剥掉。
    expect(filterCssPath('div#radix-:r37:.glass-panel')).toBe('div.glass-panel');
    expect(filterCssPath('div#radix-:r1ab:')).toBe('div');
  });
  it('filters numeric-only classes (Tailwind arbitrary value residue)', () => {
    // Tailwind v4 `col-5` / `basis-3` 等合并后偶尔留纯数字 class，语义为零。
    expect(filterCssPath('div.5.shrink-0')).toBe('div.shrink-0');
    expect(hasUnstableClass('div.5')).toBe(true);
    expect(hasUnstableClass('div.shrink-0')).toBe(false);
  });
  it('filters Radix data-[state] attributes kept as class by buildCssPath', () => {
    // buildCssPath 把整段 className（含 `data-[state=open]:animate-in`）当作 class 段保留，
    // 这些状态值每次切换都变，必须当 STATE 丢掉。注意：扁平切分后 `data-[state=open]:animate-in`
    // 会被切成两个 token —— `.data-`（纯 class 段）和 `[state=open]:animate-in`（属性选择器段），
    // 两者任一命中 STATE_ATTR_RE 都要丢弃。
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
    // form 容器上的 md:flex-row / auth-page-enter 整体被剥到只剩稳定容器 class
    expect(filterCssPath('div.md:flex-row.auth-page-enter.div.glass-card'))
      .toContain('glass-card');
    expect(filterCssPath('div.md:flex-row.auth-page-enter.div.glass-card'))
      .not.toContain('md:flex-row');
  });
});

describe('transient interaction-state classes（悬停/聚焦瞬态）', () => {
  // 回归动机：规则查看 用例回放 count=0——录制时鼠标悬停行带 Element-UI .hover-row，
  // 回放无鼠标悬停该 class 必不存在。
  it('isTransientStateClass: hover-row / current-row / is-hover / 后缀族', () => {
    expect(isTransientStateClass('hover-row')).toBe(true);
    expect(isTransientStateClass('current-row')).toBe(true);
    expect(isTransientStateClass('is-hover')).toBe(true);
    expect(isTransientStateClass('is-active')).toBe(true);
    expect(isTransientStateClass('cell-hover')).toBe(true);
    expect(isTransientStateClass('ant-table-cell-row-hover')).toBe(true);
    expect(isTransientStateClass('tab-active')).toBe(true);
    // 稳定结构类不误伤
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
    // 输入契约：' > ' 连接的子代组合器路径（finder / buildCssPathFallback 的产出形式）。
    expect(filterCssPath('table > tr.el-table__row.hover-row > td > .icon-chakan'))
      .toBe('table > tr.el-table__row > td > .icon-chakan');
    expect(filterCssPath('tr.is-hover > td')).toBe('tr > td');
    expect(filterCssPath('li.el-menu-item.is-active')).toBe('li.el-menu-item');
    expect(filterCssPath('tr.current-row > td')).toBe('tr > td');
  });
});

describe('isUtilityClass (Tailwind strip)', () => {
  it('detects plain Tailwind utilities', () => {
    expect(isUtilityClass('flex')).toBe(true);
    expect(isUtilityClass('w-full')).toBe(true);
    expect(isUtilityClass('h-dvh')).toBe(true);
    expect(isUtilityClass('overflow-hidden')).toBe(true);
    expect(isUtilityClass('items-center')).toBe(true);
    // 任意 Tailwind 前缀 + dash-token 都识别（hover:bg-blue-500 等冒号修饰符不匹配——
    // Tailwind 前缀解析阶段已剥掉。`text-[12px]` / `w-1/2` 的方括号斜杠非合法 JS class token，
    // 浏览器拿到的是浏览器生成的合法 CSS 字面量；Tailwind 编译器会剥为稳定 token。
    // 我们的检测仅对稳定 token 起作用；不影响录制策略。
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
    expect(isUtilityClass('LoginForm')).toBe(false); // uppercase 不匹配（regex anchor 是小写前缀）
    expect(isUtilityClass('foo-bar')).toBe(false);
  });
  it('filterCssPath strips utilities but keeps semantic class', () => {
    expect(filterCssPath('button.group-nav-tile.w-full.flex.items-center.justify-center'))
      .toBe('button.group-nav-tile');
    // `group` 在 SEMANTIC_KEEP 中（iDO 语义），不剥离。
    expect(filterCssPath('div.glass-card.project-card.cursor-pointer.group'))
      .toBe('div.glass-card.project-card.group');
    // 工具类剥离后该段只剩 `div` tag（与 runtime-id 行为一致：tag 保留，类被剥完）。
    expect(filterCssPath('body > div#root > div.flex.h-dvh.overflow-hidden > nav.glass-panel'))
      .toBe('body > div#root > div > nav.glass-panel');
  });
  it('hasUnstableClass flags utility-laden paths', () => {
    expect(hasUnstableClass('body.flex.h-dvh')).toBe(true);
    expect(hasUnstableClass('button.w-full')).toBe(true);
    // 纯语义类路径稳定
    expect(hasUnstableClass('button.group-nav-tile')).toBe(false);
  });
});