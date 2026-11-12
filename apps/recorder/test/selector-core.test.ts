import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { generateLocators, deriveSemantic, positionalOwnClassCandidate } from '../modules/selector-core.js';

let document: Document;

beforeEach(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  document = dom.window.document;
  // selector-core.ts accesses nodes through the bare `document` — in ESM that is the document on globalThis,
  // which does not auto-sync with our module-local binding. globalThis.document must point at the same instance,
  // otherwise finder runs its uniqueness checks against vitest jsdom env's default global document (empty body),
  // falls back to the hand-built path when no unique selector is found, and the preferredDataAttribute difference becomes invisible.
  (globalThis as { document?: Document }).document = dom.window.document;
  // @medv/finder uses the global Node / CSS.escape internally; jsdom doesn't implement CSS.escape.
  // Polyfill to the native CSS.escape for the test run (Node 21+ / Chrome 93+ all support it).
  // Must use the native fallback directly — no more `globalThis.CSS?.escape ? ... : ...` — otherwise finder calling
  // the polyfill would call back into itself, recursing infinitely until stack overflow.
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
    // finder runs penalty ranking: stable class chain < Tailwind utility chain; once [data-testid=...] / .group-nav-tile / .glass-panel
    // in the parent chain are hit, the whole path uses semantic classes and contains no Tailwind utilities.
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
    // Verifies css candidates (medv/finder) still cover a plain button after xpath removal.
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
    expect(text!.endsWith(' ')).toBe(false); // not cut mid-word
  });

  it('emits short text when content is stable', () => {
    const dom = new JSDOM('<span>项目详情</span>');
    const span = dom.window.document.querySelector('span')!;
    expect(generateLocators(span).find((l) => l.strategy === 'text')?.value).toBe('项目详情');
  });

  it('drops text candidate when element has element children (container, not leaf)', () => {
    // A dialog/card container's innerText is the whole subtree concatenated; once matched, the "text" replay locks onto
    // becomes the parent container instead of the child element the user actually clicked. Must be dropped.
    const dom = new JSDOM(`<div role="dialog"><h1>编辑项目</h1><button>取消</button></div>`);
    const dialog = dom.window.document.querySelector('[role="dialog"]')!;
    expect(generateLocators(dialog).find((l) => l.strategy === 'text')).toBeUndefined();
    // But the child button still produces its own text candidate.
    const btn = dom.window.document.querySelector('button')!;
    expect(generateLocators(btn).find((l) => l.strategy === 'text')?.value).toBe('取消');
  });

  it('keeps text candidate for button whose label lives in a child span/icon', () => {
    // <span>登录</span> inside a button: the button itself has element children but is still "self-leaf UI",
    // so the subtree text should be the name — otherwise the role candidate loses its name and becomes a bare 'button'.
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
    // Multiple data-* attributes are in the attr candidates: finder sorts by penalty,
    // and preferredDataAttribute raises its priority to the #id tier, ensuring the whole parent chain uses that attribute.
    // Note: the DOM must contain multiple same-named spans, otherwise finder optimizes straight to the `span`
    // single-element path (penalty 2), where no attribute anchor is needed. Also, the element must land in
    // globalThis.document.body, otherwise finder fails to find a unique selector and falls back to the manual
    // path, hiding the difference the attr option makes.
    //
    // In the default attr callback both data-qa/data-testid are already whitelisted, so even the default call
    // produces [data-*] paths — the preferred differentiation only shows when multiple data-* attributes exist
    // on the parent chain: finder picks the attribute with the lower penalty and the whole chain switches with it.
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
    // Prepare a control group with data-qa only (no data-testid), so data-testid matching first doesn't
    // get treated as an equal-best optimum by penalty sorting. preferred short-circuits in the attr callback,
    // letting the whole path switch to [data-qa=...].
    const dom2 = new JSDOM(`<!doctype html><html><body>
      <div id="root">
        <div data-qa="projects"><span>项目</span></div>
        <div data-qa="other"><span>其他</span></div>
      </div>
    </body></html>`);
    while (dom2.window.document.body.firstChild) {
      document.body.appendChild(dom2.window.document.body.firstChild);
    }
    const span2 = document.querySelectorAll('span')[2]!; // the second span lives in dom2
    // Default (preferred=data-testid) → parent chain goes through [data-testid="projects-list"]; once matched, #root is unnecessary.
    const cssDefault = generateLocators(span).find((l) => l.strategy === 'css')!.value;
    expect(cssDefault).toContain('data-testid');
    expect(cssDefault).toContain('projects-list');
    expect(cssDefault).not.toContain('data-qa');
    // preferred=data-qa → parent chain switches to [data-qa="projects"] (when no data-testid interferes).
    const cssCustom = generateLocators(span2, { preferredDataAttribute: 'data-qa' }).find((l) => l.strategy === 'css')!.value;
    expect(cssCustom).toContain('data-qa');
    expect(cssCustom).toContain('projects');
  });
});

describe('selector-core — 悬停瞬态与属性名候选（规则查看 用例回归）', () => {
  /** Mounts the JSDOM document onto globalThis.document.body — finder uses document.body as the root for
   *  uniqueness checks; detached elements make finder throw and fall back to the manual path. */
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

  it('可排序表头 cell：运行时位置类（el-table_1_column_4 / has-gutter）不进 css 候选', () => {
    // Regression motive: step 4 of the 资产管理-资产编辑 case asserted the sole candidate .has-gutter .el-table_1_column_4 > .cell,
    // which replayed count=0 (instance/column order drifts across sessions + gutter layout state), while the page text "主识别IP" was clearly there.
    const dom = new JSDOM(`<!doctype html><html><body>
      <div class="el-table">
        <div class="el-table__header-wrapper">
          <table>
            <thead>
              <tr class="has-gutter">
                <th class="el-table_1_column_1"><div class="cell"><label class="el-checkbox">全选</label></div></th>
                <th class="el-table_1_column_2 is-sortable"><div class="cell">主识别IP<span class="caret-wrapper"><i class="sort-caret ascending"></i><i class="sort-caret descending"></i></span></div></th>
                <th class="el-table_1_column_3 is-sortable"><div class="cell">资产类型<span class="caret-wrapper"><i class="sort-caret ascending"></i><i class="sort-caret descending"></i></span></div></th>
                <th class="el-table_1_column_4"><div class="cell">归属部门</div></th>
              </tr>
            </thead>
          </table>
        </div>
      </div>
    </body></html>`);
    mountToBody(dom);
    const cell = document.querySelectorAll('.el-table__header-wrapper .cell')[1]!;
    const locs = generateLocators(cell);
    const allCss = locs.filter((l) => l.strategy === 'css').map((l) => l.value);
    expect(allCss.length).toBeGreaterThan(0);
    for (const v of allCss) {
      expect(v).not.toMatch(/el-table_\d+(?:_column_\d+)?/);
      expect(v).not.toContain('has-gutter');
    }
    // Degenerate-fact record: div.cell contains sort caret children → not a leaf → no text candidate (th has no role/testId either).
    // This is exactly why the assertion panel relies on r.text to add a text fallback candidate (content/panel.js assert branch).
    expect(locs.find((l) => l.strategy === 'text')).toBeUndefined();
  });

  it('纯图标元素：title 属性不产 text 候选（getByText 看不到属性），改产 [title=...] css 候选', () => {
    const dom = new JSDOM('<i class="icon-chakan" title="查看"></i>');
    const icon = dom.window.document.querySelector('i')!;
    const locs = generateLocators(icon);
    expect(locs.find((l) => l.strategy === 'text')).toBeUndefined();
    expect(locs.find((l) => l.strategy === 'css' && l.value === '[title="查看"]')).toBeDefined();
  });
  it('属性候选排在 finder 链之后（唯一性强的链先探测）', () => {
    // 规则查看 backtest regression: [title="查看"] exists in every table row (naturally multi-match); ranking it
    // before the strongest-unique finder chain makes the replay's first probe hit it and degrade to .first(), grabbing the .hidden-columns hidden clone.
    const dom = new JSDOM('<i class="icon-chakan" title="查看"></i>');
    const icon = dom.window.document.querySelector('i')!;
    const cssList = generateLocators(icon).filter((l) => l.strategy === 'css').map((l) => l.value);
    const idxChain = cssList.findIndex((v) => v.includes('icon-chakan'));
    const idxTitle = cssList.findIndex((v) => v === '[title="查看"]');
    expect(idxChain).toBeGreaterThanOrEqual(0);
    expect(idxTitle).toBeGreaterThan(idxChain);
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

describe('selector-core — label 关联文本（role 候选可访问名）', () => {
  it('label[for=id] 关联文本进 role 候选 name（input 自身无任何文本来源）', () => {
    // <label for> text lives outside the target element; getByText replay is guaranteed count=0 (same root cause as the 规则查看 case),
    // so it is only allowed into the role candidate — getByRole's accessible-name computation includes label association.
    const dom = new JSDOM(`<label for="u">用户名</label><input id="u" />`);
    const input = dom.window.document.querySelector('input')!;
    const locs = generateLocators(input);
    expect(locs.find((l) => l.strategy === 'role')?.value).toBe('textbox[name="用户名"]');
    // label text must not leak into the text candidate
    expect(locs.find((l) => l.strategy === 'text')).toBeUndefined();
  });

  it('包裹式 label 的文本同样进 role 候选 name', () => {
    const dom = new JSDOM(`<label>密码<input type="password" /></label>`);
    const input = dom.window.document.querySelector('input')!;
    expect(generateLocators(input).find((l) => l.strategy === 'role')?.value).toBe('textbox[name="密码"]');
  });

  it('aria-label 仍优先于 label 关联文本（属性名最稳）', () => {
    const dom = new JSDOM(`<label for="a">备注</label><input id="a" aria-label="账号" />`);
    const input = dom.window.document.querySelector('input')!;
    expect(generateLocators(input).find((l) => l.strategy === 'role')?.value).toBe('textbox[name="账号"]');
  });

  it('volatile 的 label 文本不产 role 候选 name（同 text 候选口径）', () => {
    const dom = new JSDOM(`<label for="t">13 天前</label><input id="t" />`);
    const input = dom.window.document.querySelector('input')!;
    expect(generateLocators(input).find((l) => l.strategy === 'role')).toBeUndefined();
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