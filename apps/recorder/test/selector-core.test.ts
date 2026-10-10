import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { generateLocators, deriveSemantic, positionalOwnClassCandidate } from '../modules/selector-core.js';

let document: Document;

beforeEach(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  document = dom.window.document;
  // selector-core.ts 通过 bare `document` 访问节点——ESM 里这是 globalThis 上的 document，
  // 不会自动跟我们的模块局部 binding 同步。需要把 globalThis.document 也指向同一个实例，
  // 否则 finder 会用 vitest jsdom env 默认的全局 document（空 body）做唯一性校验，
  // 找不到唯一 selector 后回退到手工 path，看不出 preferredDataAttribute 的差别。
  (globalThis as { document?: Document }).document = dom.window.document;
  // @medv/finder 内部用全局 Node / CSS.escape，jsdom 不实现 CSS.escape。
  // 测试期 polyfill 到原生 CSS.escape（Node 21+ / Chrome 93+ 全支持）。
  // 必须直接用原生 fallback，不能再 `globalThis.CSS?.escape ? ... : ...`——否则 finder 调用
  // polyfill 时会反过来调到自己，无限递归直到 stack overflow。
  (globalThis as { Node?: unknown }).Node = (dom.window as { Node: unknown }).Node;
  const nativeEscape: ((s: string) => string) | undefined = (globalThis as {
    CSS?: { escape?: (s: string) => string };
  }).CSS?.escape;
  (globalThis as { CSS: { escape: (s: string) => string } }).CSS = {
    escape: nativeEscape ?? ((s: string) => String(s).replace(/([!"#$%&'()*+,./:;<=>?@\[\\\]^`{|}~])/g, '\\$1')),
  };
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

  it('no longer emits xpath locator', () => {
    const el = makeEl('<button>ok</button>');
    const locs = generateLocators(el);
    expect(locs.find((l) => l.strategy === 'xpath')).toBeUndefined();
  });

  it('limits to 5 candidates', () => {
    const el = makeEl('<button data-testid="x" aria-label="y">z</button>');
    const locs = generateLocators(el);
    expect(locs.length).toBeLessThanOrEqual(5);
  });

  it('emits placeholder as independent css candidate', () => {
    const el = makeEl('<input placeholder="账号" />');
    const locs = generateLocators(el);
    expect(locs.find((l) => l.strategy === 'css' && l.value === '[placeholder="账号"]')).toBeDefined();
  });

  it('emits name as independent css candidate', () => {
    const el = makeEl('<input name="username" />');
    const locs = generateLocators(el);
    expect(locs.find((l) => l.strategy === 'css' && l.value === '[name="username"]')).toBeDefined();
  });

  it('escapes double quotes in placeholder css selector', () => {
    const el = makeEl('<input placeholder=\'用户"专用"\' />');
    const locs = generateLocators(el);
    const ph = locs.find((l) => l.strategy === 'css' && l.value.includes('placeholder'));
    expect(ph?.value).toBe('[placeholder="用户\\"专用\\""]');
  });

  it('drops placeholder candidate when empty / whitespace-only', () => {
    const el = makeEl('<input placeholder="   " />');
    const locs = generateLocators(el);
    expect(locs.find((l) => l.strategy === 'css' && l.value.includes('placeholder'))).toBeUndefined();
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

describe('selector-core — Tailwind-aware CSS', () => {
  it('strips utilities around semantic classes', () => {
    const dom = new JSDOM(`<!doctype html><html><body>
      <div id="root"><nav class="glass-panel"><div><button class="group-nav-tile"><svg><path></path></svg></button></div></nav></div>
    </body></html>`);
    const path = dom.window.document.querySelector('path')!;
    const css = generateLocators(path).find((l) => l.strategy === 'css')!.value;
    // finder 走 penalty 排序：稳定 class 链 < Tailwind utility 链；父链 [data-testid=...] / .group-nav-tile / .glass-panel
    // 命中后整条路径都用语义 class，不再包含 Tailwind utility。
    expect(css).toMatch(/(group-nav-tile|glass-panel)/);
    expect(css).not.toMatch(/\b(flex|w-full|h-dvh|items-center|justify-center|overflow-hidden)\b/);
  });
});

describe('selector-core — placeholder/name candidates replace xpath', () => {
  it('SOC-style username input: name + placeholder + role + css all present', () => {
    const dom = new JSDOM(`<input type="text" name="username" placeholder="账号" />`);
    const input = dom.window.document.querySelector('input')!;
    const locs = generateLocators(input);
    const cssList = locs.filter((l) => l.strategy === 'css').map((l) => l.value);
    expect(cssList).toContain('[placeholder="账号"]');
    expect(cssList).toContain('[name="username"]');
    expect(locs.find((l) => l.strategy === 'xpath')).toBeUndefined();
  });

  it('SOC-style password input: emits [placeholder] + [name] for both name+placeholder attrs', () => {
    const dom = new JSDOM(`<input type="password" name="password" placeholder="密码" />`);
    const input = dom.window.document.querySelector('input')!;
    const cssList = generateLocators(input).filter((l) => l.strategy === 'css').map((l) => l.value);
    expect(cssList).toContain('[placeholder="密码"]');
    expect(cssList).toContain('[name="password"]');
  });

  it('input with only name (no placeholder) still emits [name] candidate', () => {
    const dom = new JSDOM(`<input name="csrfToken" />`);
    const input = dom.window.document.querySelector('input')!;
    const cssList = generateLocators(input).filter((l) => l.strategy === 'css').map((l) => l.value);
    expect(cssList).toContain('[name="csrfToken"]');
  });

  it('button with no form attrs still produces css candidate without placeholder/name', () => {
    // 验证移除 xpath 后 css 候选(medv/finder)仍能 cover 普通 button。
    const dom = new JSDOM(`<button class="login-btn">登录</button>`);
    const btn = dom.window.document.querySelector('button')!;
    const locs = generateLocators(btn);
    expect(locs.find((l) => l.strategy === 'css')?.value).toContain('button');
    expect(locs.find((l) => l.strategy === 'xpath')).toBeUndefined();
  });
});

describe('selector-core — hardened text candidate', () => {
  it('drops text candidate for volatile time content', () => {
    const dom = new JSDOM('<div><span>活跃 13 天前</span></div>');
    const span = dom.window.document.querySelector('span')!;
    const text = generateLocators(span).find((l) => l.strategy === 'text')?.value;
    expect(text).toBeUndefined();
  });

  it('drops text candidate for counter tails like 待澄清 1', () => {
    const dom = new JSDOM('<span>待澄清 1</span>');
    const span = dom.window.document.querySelector('span')!;
    expect(generateLocators(span).find((l) => l.strategy === 'text')?.value).toBeUndefined();
  });

  it('skips text candidate for svg/path', () => {
    const dom = new JSDOM('<svg><path>some inner text</path></svg>');
    const path = dom.window.document.querySelector('path')!;
    expect(generateLocators(path).find((l) => l.strategy === 'text')).toBeUndefined();
  });

  it('truncates long text at last word boundary ≤ 50 chars', () => {
    const long = 'foo bar baz qux quux corge grault garply waldo fred plugh xyzzy thud foo bar baz qux quux corge';
    const dom = new JSDOM(`<span>${long}</span>`);
    const span = dom.window.document.querySelector('span')!;
    const text = generateLocators(span).find((l) => l.strategy === 'text')?.value;
    expect(text!.length).toBeLessThanOrEqual(50);
    expect(text!.endsWith(' ')).toBe(false); // 不在词中间切
  });

  it('emits short text when content is stable', () => {
    const dom = new JSDOM('<span>项目详情</span>');
    const span = dom.window.document.querySelector('span')!;
    expect(generateLocators(span).find((l) => l.strategy === 'text')?.value).toBe('项目详情');
  });

  it('drops text candidate when element has element children (container, not leaf)', () => {
    // 对话框 / 卡片等容器的 innerText 是整棵子树拼接，命中后回放锁定的「文本」会变成父容器，
    // 而不是用户真正点的子元素。必须丢弃。
    const dom = new JSDOM(`<div role="dialog"><h1>编辑项目</h1><button>取消</button></div>`);
    const dialog = dom.window.document.querySelector('[role="dialog"]')!;
    expect(generateLocators(dialog).find((l) => l.strategy === 'text')).toBeUndefined();
    // 但子节点 button 仍然产自己的 text 候选。
    const btn = dom.window.document.querySelector('button')!;
    expect(generateLocators(btn).find((l) => l.strategy === 'text')?.value).toBe('取消');
  });

  it('keeps text candidate for button whose label lives in a child span/icon', () => {
    // button 里的 <span>登录</span>：button 自身含 element 子节点但仍是「叶子 UI」，
    // 应取子树文本作为 name，否则 role 候选会丢 name 变成裸 'button'。
    const dom = new JSDOM(`<button class="btn-primary"><span class="icon"></span><span>登录</span></button>`);
    const btn = dom.window.document.querySelector('button')!;
    expect(generateLocators(btn).find((l) => l.strategy === 'role')?.value).toBe('button[name="登录"]');
  });

  it('keeps text candidate for <a> with child icon + label', () => {
    const dom = new JSDOM(`<a href="/x"><svg></svg>退出登录</a>`);
    const a = dom.window.document.querySelector('a')!;
    expect(generateLocators(a).find((l) => l.strategy === 'role')?.value).toBe('link[name="退出登录"]');
  });
});

describe('selector-core — preferredDataAttribute', () => {
  it('uses custom preferredDataAttribute for CSS path when present', () => {
    // 多个 data-* 属性都在 attr 候选里：finder 走 penalty 排序，
    // preferredDataAttribute 把它的优先级提到 #id 同级，确保整条父链都走这个属性。
    // 注意：DOM 必须有多个同名 span，否则 finder 会直接优化成 `span` 单元素路径（penalty 2），
    // 此时不需要任何属性锚点。同时元素必须落在 globalThis.document.body 里，
    // 否则 finder 找不到唯一 selector 后回退到手工 path，看不出 attr 选项的差别。
    //
    // 默认 attr callback 里 data-qa/data-testid 都已经在白名单，所以默认调用也会产出
    // [data-*] 路径——只有当父链同时存在多个 data-* 时，preferred 的差异化才显现：
    // finder 会优先挑 penalty 更低的那个属性，整条父链都跟着切。
    const dom = new JSDOM(`<!doctype html><html><body>
      <div id="root">
        <div data-testid="projects-list" data-qa="projects"><span>项目</span></div>
        <div data-testid="other"><span>其他</span></div>
      </div>
    </body></html>`);
    while (dom.window.document.body.firstChild) {
      document.body.appendChild(dom.window.document.body.firstChild);
    }
    const span = document.querySelectorAll('span')[0]!;
    // 准备一个仅 data-qa（不挂 data-testid）的对照组，避免 data-testid 仍能命中后被
    // penalty 排序当成同分最优。preferred 在 attr callback 里短路命中，整条路径就能切到 [data-qa=...]。
    const dom2 = new JSDOM(`<!doctype html><html><body>
      <div id="root">
        <div data-qa="projects"><span>项目</span></div>
        <div data-qa="other"><span>其他</span></div>
      </div>
    </body></html>`);
    while (dom2.window.document.body.firstChild) {
      document.body.appendChild(dom2.window.document.body.firstChild);
    }
    const span2 = document.querySelectorAll('span')[2]!; // 第二个 span 在 dom2 里
    // 默认（preferred=data-testid）→ 父链走 [data-testid="projects-list"]，命中后不需要 #root。
    const cssDefault = generateLocators(span).find((l) => l.strategy === 'css')!.value;
    expect(cssDefault).toContain('data-testid');
    expect(cssDefault).toContain('projects-list');
    expect(cssDefault).not.toContain('data-qa');
    // preferred=data-qa → 父链改走 [data-qa="projects"]（无 data-testid 干扰时）。
    const cssCustom = generateLocators(span2, { preferredDataAttribute: 'data-qa' }).find((l) => l.strategy === 'css')!.value;
    expect(cssCustom).toContain('data-qa');
    expect(cssCustom).toContain('projects');
  });
});

describe('selector-core — 悬停瞬态与属性名候选（规则查看 用例回归）', () => {
  /** 把 JSDOM 文档挂到 globalThis.document.body——finder 以 document.body 为 root 做唯一性校验，
   *  detached 元素会让 finder 抛错走 fallback 路径。 */
  function mountToBody(dom: JSDOM) {
    while (dom.window.document.body.firstChild) {
      document.body.appendChild(dom.window.document.body.firstChild);
    }
  }

  it('悬停行 .hover-row 不进任何 css 候选（finder className 过滤）', () => {
    const dom = new JSDOM(`<!doctype html><html><body>
      <table><tbody>
        <tr class="el-table__row hover-row"><td><i class="icon-chakan" title="查看"></i></td></tr>
        <tr class="el-table__row"><td><i class="icon-chakan" title="查看"></i></td></tr>
      </tbody></table>
    </body></html>`);
    mountToBody(dom);
    const icon = document.querySelector('tr .icon-chakan')!;
    const cssLocs = generateLocators(icon).filter((l) => l.strategy === 'css');
    expect(cssLocs.length).toBeGreaterThan(0);
    expect(cssLocs.every((l) => !l.value.includes('hover-row'))).toBe(true);
  });

  it('纯图标元素：title 属性不产 text 候选（getByText 看不到属性），改产 [title=...] css 候选', () => {
    const dom = new JSDOM('<i class="icon-chakan" title="查看"></i>');
    const icon = dom.window.document.querySelector('i')!;
    const locs = generateLocators(icon);
    expect(locs.find((l) => l.strategy === 'text')).toBeUndefined();
    expect(locs.find((l) => l.strategy === 'css' && l.value === '[title="查看"]')).toBeDefined();
  });

  it('aria-label 属性同样不产 text 候选，产 [aria-label=...] css 候选', () => {
    const dom = new JSDOM('<span aria-label="展开详情"></span>');
    const el = dom.window.document.querySelector('span')!;
    const locs = generateLocators(el);
    expect(locs.find((l) => l.strategy === 'text')).toBeUndefined();
    expect(locs.find((l) => l.strategy === 'css' && l.value === '[aria-label="展开详情"]')).toBeDefined();
  });

  it('有子树文本的元素照旧产 text 候选，且不重复给属性兜底候选', () => {
    const dom = new JSDOM('<button aria-label="提交">保存</button>');
    const btn = dom.window.document.querySelector('button')!;
    const locs = generateLocators(btn);
    expect(locs.find((l) => l.strategy === 'text')?.value).toBe('保存');
    expect(locs.find((l) => l.strategy === 'css' && l.value.startsWith('[aria-label'))).toBeUndefined();
  });

  it('input 的 placeholder 不再产 text 候选（getByText 看不到 placeholder）', () => {
    const dom = new JSDOM('<input placeholder="账号" />');
    const input = dom.window.document.querySelector('input')!;
    const locs = generateLocators(input);
    expect(locs.find((l) => l.strategy === 'text')).toBeUndefined();
    expect(locs.find((l) => l.strategy === 'css' && l.value === '[placeholder="账号"]')).toBeDefined();
  });
});

describe('positionalOwnClassCandidate — 位置链兜底候选', () => {
  it('≥3 段 :nth-of-type 且元素带可辨识 class → 给 .own-class 候选', () => {
    const dom = new JSDOM('<div class="op-btn icon-edit">A</div>');
    const el = dom.window.document.querySelector('div')!;
    const css = '.scroller > div > div > div:nth-of-type(1) > div:nth-of-type(2) > div:nth-of-type(1)';
    expect(positionalOwnClassCandidate(css, el)).toBe('.op-btn.icon-edit');
  });
  it('位置段不足 3 → null（唯一性更强的大链无需兜底）', () => {
    const dom = new JSDOM('<div class="op-btn">A</div>');
    const el = dom.window.document.querySelector('div')!;
    expect(positionalOwnClassCandidate('tr:nth-of-type(3) .icon-chakan', el)).toBeNull();
  });
  it('元素无可辨识 class（bare / 仅组件库或 utility class）→ null', () => {
    const dom = new JSDOM('<div class="el-button flex w-full"></div>');
    const el = dom.window.document.querySelector('div')!;
    expect(positionalOwnClassCandidate('div:nth-of-type(1) > div:nth-of-type(2) > div:nth-of-type(1)', el)).toBeNull();
  });
  it(':nth-child 与 :nth-of-type 同计数', () => {
    const dom = new JSDOM('<div class="op-btn">A</div>');
    const el = dom.window.document.querySelector('div')!;
    expect(positionalOwnClassCandidate('div:nth-child(1) > div:nth-child(2) > div:nth-child(3)', el)).toBe('.op-btn');
  });
});

describe('deriveSemantic — semantic fallback', () => {
  it('prefers data-testid when present', () => {
    const dom = new JSDOM('<button data-testid="login-btn">登录</button>');
    const btn = dom.window.document.querySelector('button')!;
    expect(deriveSemantic(btn)).toEqual({ semanticRole: 'login-btn', contextText: '登录' });
  });

  it('falls back to name attribute when no data-testid', () => {
    const dom = new JSDOM('<input name="username" />');
    const input = dom.window.document.querySelector('input')!;
    expect(deriveSemantic(input)?.semanticRole).toBe('username');
  });

  it('falls back to known semantic class', () => {
    const dom = new JSDOM('<button class="group-nav-tile w-full flex items-center">x</button>');
    const btn = dom.window.document.querySelector('button')!;
    expect(deriveSemantic(btn)).toEqual({ semanticRole: 'group-nav-tile', contextText: 'x' });
  });

  it('falls back to aria-label when no class/id/name', () => {
    const dom = new JSDOM('<button aria-label="关闭弹窗"></button>');
    const btn = dom.window.document.querySelector('button')!;
    expect(deriveSemantic(btn)?.semanticRole).toBe('关闭弹窗');
  });

  it('returns undefined when only utility classes exist', () => {
    const dom = new JSDOM('<button class="flex w-full items-center">x</button>');
    const btn = dom.window.document.querySelector('button')!;
    expect(deriveSemantic(btn)).toBeUndefined();
  });

  it('trims contextText and skips when empty', () => {
    const dom = new JSDOM('<button class="group-nav-tile"></button>');
    const btn = dom.window.document.querySelector('button')!;
    expect(deriveSemantic(btn)).toEqual({ semanticRole: 'group-nav-tile' });
  });
});