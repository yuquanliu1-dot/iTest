/**
 * Unit tests for the verify_case locator gate: the gate must never be stricter than formal replay (cdp.ts tryFirstMatch).
 * The root causes from the 2026-11-07 prod228 record live here: the gate judged "false ambiguity" by substring matching and judged
 * later actions' locator misses against the "pre-step" DOM — both would kill steps replay could actually complete.
 *
 * The fake DOM replicates Playwright's three key semantics with a minimal model:
 *  ① getByRole/getByText match by substring by default (only exact matches the whole string);
 *  ② text matching picks "the smallest element containing the text";
 *  ③ with multiple element hits, replay falls back to filter({visible:true}).first() (the first visible match in DOM order).
 */
import { describe, it, expect } from 'vitest';
import { checkCompiledLocators, locatorAnchorName, nextRoundState } from './verifyCase.js';

interface FakeEl {
  id: string;
  /** Own text (descendants excluded). */
  own: string;
  visible: boolean;
  role?: string;
  /** Accessible name (for role matching) — Element-UI cascader's parent li counts child-column text into it (pollution). */
  accName?: string;
  testid?: string;
  children: FakeEl[];
}

function descendants(el: FakeEl): FakeEl[] {
  const out: FakeEl[] = [];
  for (const c of el.children) {
    out.push(c);
    out.push(...descendants(c));
  }
  return out;
}

/** An element's visible text (own + descendant text), corresponding to Playwright's innerText. */
function fullText(el: FakeEl): string {
  return el.own + el.children.map(fullText).join('');
}

/** Playwright text engine: picks "the smallest element containing the text"; exact requires whole-string equality. */
function textMatch(el: FakeEl, t: string, exact: boolean): boolean {
  const hit = (s: string): boolean => (exact ? s.trim() === t : s.includes(t));
  if (!hit(fullText(el))) return false;
  return !descendants(el).some((d) => hit(fullText(d)));
}

class FakeLocator {
  constructor(
    readonly els: FakeEl[],
    readonly page: FakePage,
  ) {}

  async count(): Promise<number> {
    return this.els.length;
  }

  first(): FakeLocator {
    return new FakeLocator(this.els.slice(0, 1), this.page);
  }

  filter(opts: { visible?: boolean; has?: FakeLocator }): FakeLocator {
    let els = this.els;
    if (opts.visible) els = els.filter((e) => e.visible);
    if (opts.has) {
      const inner = opts.has.els;
      els = els.filter((e) => inner.some((h) => descendants(e).includes(h)));
    }
    return new FakeLocator(els, this.page);
  }

  async innerText(): Promise<string> {
    const first = this.els[0];
    return first ? fullText(first) : '';
  }
}

class FakePage {
  constructor(private roots: FakeEl[]) {}

  /** Page-level matched elements = all descendants (DOM order). */
  private all(): FakeEl[] {
    const out: FakeEl[] = [];
    for (const r of this.roots) {
      out.push(r);
      out.push(...descendants(r));
    }
    return out;
  }

  locator(selector: string): FakeLocator {
    const testid = selector.match(/^\[data-testid="(.+)"\]$/);
    if (testid) return new FakeLocator(this.all().filter((e) => e.testid === testid[1]), this);
    const id = selector.match(/^#([\w-]+)$/);
    if (id) return new FakeLocator(this.all().filter((e) => e.id === id[1]), this);
    return new FakeLocator([], this);
  }

  getByRole(role: string, options?: { name?: string; exact?: boolean }): FakeLocator {
    const name = options?.name;
    return new FakeLocator(
      this.all().filter((e) => {
        if (e.role !== role) return false;
        if (name === undefined) return true;
        const acc = e.accName ?? '';
        return options?.exact ? acc === name : acc.includes(name);
      }),
      this,
    );
  }

  getByText(text: string, options?: { exact?: boolean }): FakeLocator {
    return new FakeLocator(this.all().filter((e) => textMatch(e, text, options?.exact === true)), this);
  }

  async waitForTimeout(_ms: number): Promise<void> {
    /* The probe window doesn't need to really wait in the fake DOM */
  }
}

const NAME = '长沙市烟草专卖局（公司）';

/** Element-UI cascader panel: level0's li embeds level1's column (the parent li's accessible name is polluted by child-column text). */
function cascaderFixture(order: 'target-first' | 'other-first'): FakePage {
  const level0: FakeEl = {
    id: 'cascader-menu-502-0-0',
    own: '',
    visible: true,
    role: 'menuitem',
    accName: `${NAME}${NAME}（本级）`,
    children: [
      { id: 'label-0', own: NAME, visible: true, children: [] },
      {
        id: 'cascader-menu-502-1-10',
        own: '',
        visible: true,
        role: 'menuitem',
        accName: `${NAME}（本级）`,
        children: [{ id: 'label-1', own: `${NAME}（本级）`, visible: true, children: [] }],
      },
    ],
  };
  if (order === 'target-first') return new FakePage([level0]);
  // The 「（本级）」 entry sorts earlier in DOM order → replay's first() would click the wrong entry → the ambiguity must be preserved
  const other: FakeEl = {
    id: 'other-menu-item',
    own: '',
    visible: true,
    role: 'menuitem',
    accName: `${NAME}（本级）`,
    children: [{ id: 'other-label', own: `${NAME}（本级）`, visible: true, children: [] }],
  };
  return new FakePage([other, level0]);
}

const cascaderClick = {
  kind: 'click',
  locator: [
    { strategy: 'role', value: `menuitem[name='${NAME}']` },
    { strategy: 'text', value: NAME },
  ],
};

describe('checkCompiledLocators（闸门口径对齐回放）', () => {
  it('假歧义：DOM 序第一个可见匹配就是目标 → 不判歧义（回放点得对）', async () => {
    const page = cascaderFixture('target-first');
    const err = await checkCompiledLocators(page as never, [cascaderClick], 'pre');
    expect(err).toBeNull();
  });

  it('真歧义：DOM 序第一个可见匹配是另一个条目 → 判 AmbiguousLocator', async () => {
    const page = cascaderFixture('other-first');
    const err = await checkCompiledLocators(page as never, [cascaderClick], 'pre');
    expect(err?.reason).toBe('AmbiguousLocator');
  });

  it('歧义提示禁荐运行时实例 id', async () => {
    const page = cascaderFixture('other-first');
    const err = await checkCompiledLocators(page as never, [cascaderClick], 'pre');
    expect(err?.message).toContain('运行时实例 id');
    expect(err?.message).toContain('#cascader-menu-');
  });

  it('pre 只判第一个 click：后续动作的目标此刻不在 DOM 里 → 不判失败（交给结尾干跑）', async () => {
    const page = new FakePage([
      { id: 'open', own: '打开面板', visible: true, children: [] },
    ]);
    const compiled = [
      { kind: 'click', locator: [{ strategy: 'text', value: '打开面板' }] },
      { kind: 'click', locator: [{ strategy: 'text', value: '展开级联' }] },
    ];
    expect(await checkCompiledLocators(page as never, compiled, 'pre')).toBeNull();
  });

  it('pre 首个动作是 fill → 不判后续 click（下拉建议项要到 fill 执行后才出现）', async () => {
    const page = new FakePage([
      { id: 'search', own: '请输入关键字', visible: true, children: [] },
    ]);
    const compiled = [
      { kind: 'fill', locator: [{ strategy: 'text', value: '请输入关键字' }] },
      { kind: 'click', locator: [{ strategy: 'text', value: '建议项A' }] },
    ];
    expect(await checkCompiledLocators(page as never, compiled, 'pre')).toBeNull();
  });

  it('pre 首动作不是 click/hover（如 fill）→ 不判该步的 pre 命中（fill 归 post 判）', async () => {
    const page = new FakePage([]);
    const compiled = [{ kind: 'fill', locator: [{ strategy: 'text', value: '单位名称' }] }];
    expect(await checkCompiledLocators(page as never, compiled, 'pre')).toBeNull();
    expect((await checkCompiledLocators(page as never, compiled, 'post'))?.reason).toBe('LocatorMismatch');
  });

  it('pre 第一个动作本身缺失 → 判 LocatorMismatch', async () => {
    const page = new FakePage([]);
    const compiled = [{ kind: 'click', locator: [{ strategy: 'text', value: '打开面板' }] }];
    expect((await checkCompiledLocators(page as never, compiled, 'pre'))?.reason).toBe('LocatorMismatch');
  });

  it('navigate 之后的 click 不对着当前 DOM 判（目标属于跳转后的页面）', async () => {
    const page = new FakePage([]);
    const compiled = [
      { kind: 'navigate', url: 'https://x/y' },
      { kind: 'click', locator: [{ strategy: 'text', value: '展开级联' }] },
    ];
    expect(await checkCompiledLocators(page as never, compiled, 'pre')).toBeNull();
  });

  it('post 判最后一个动作的 locator：缺失 → LocatorMismatch', async () => {
    const page = new FakePage([]);
    const compiled = [{ kind: 'fill', locator: [{ strategy: 'text', value: '单位名称' }] }];
    expect((await checkCompiledLocators(page as never, compiled, 'post'))?.reason).toBe('LocatorMismatch');
  });

  it('post 跳过 navigate 之前的动作（目标已被换掉的页面带走）', async () => {
    const page = new FakePage([]);
    const compiled = [
      { kind: 'fill', locator: [{ strategy: 'text', value: '单位名称' }] },
      { kind: 'navigate', url: 'https://x/y' },
    ];
    expect(await checkCompiledLocators(page as never, compiled, 'post')).toBeNull();
  });

  it('移动端专用 strategy 判失败（web 回放不支持）', async () => {
    const page = new FakePage([]);
    const compiled = [{ kind: 'click', locator: [{ strategy: 'accessibilityId', value: 'btn' }] }];
    expect((await checkCompiledLocators(page as never, compiled, 'pre'))?.reason).toBe('LocatorMismatch');
  });
});

describe('locatorAnchorName', () => {
  it('text 策略取 value 本身', () => {
    expect(locatorAnchorName({ strategy: 'text', value: ' 单位名称 ' })).toBe('单位名称');
  });

  it('role 策略取 name 部分', () => {
    expect(locatorAnchorName({ strategy: 'role', value: `menuitem[name='${NAME}']` })).toBe(NAME);
    expect(locatorAnchorName({ strategy: 'role', value: `menuitem[name="${NAME}"]` })).toBe(NAME);
  });

  it('css / xpath 无文案锚点', () => {
    expect(locatorAnchorName({ strategy: 'css', value: '#a-b' })).toBeNull();
  });
});

describe('nextRoundState（停滞护栏按进展判）', () => {
  it('签名变化 → 计数重置', () => {
    const prev = { lastSignature: 'execution', consecutive: 2, lastPassed: 1 };
    expect(nextRoundState(prev, 'vision', 1).consecutive).toBe(1);
  });

  it('同签名但已确认前缀变长（有进展）→ 计数重置', () => {
    const prev = { lastSignature: 'execution', consecutive: 2, lastPassed: 1 };
    const next = nextRoundState(prev, 'execution', 2);
    expect(next.consecutive).toBe(1);
    expect(next.lastPassed).toBe(2);
  });

  it('同签名且无进展 → 计数累加', () => {
    const prev = { lastSignature: 'execution', consecutive: 2, lastPassed: 1 };
    expect(nextRoundState(prev, 'execution', 1).consecutive).toBe(3);
  });

  it('首轮 → 计数为 1', () => {
    expect(nextRoundState(undefined, 'execution', 0).consecutive).toBe(1);
  });
});
