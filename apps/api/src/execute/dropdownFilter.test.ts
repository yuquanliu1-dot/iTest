import { describe, it, expect } from 'vitest';
import type { Locator } from 'playwright-core';
import { isDropdownFilterInput, isOpenDropdownFilter } from './dropdownFilter.js';

/** Builds a minimal Element stand-in: closest returns the host when the selector string hits the host's class name.
 *  hostClass decides whether closest hits (simulating class matching); className is the host's real class string. */
function makeEl(opts: { hostClass?: string; className?: string; vue?: unknown }): Element {
  const host = opts.hostClass
    ? ({ className: opts.className ?? opts.hostClass, __vue__: opts.vue } as unknown as HTMLElement)
    : null;
  return {
    closest: (selector: string) => {
      if (!host || !opts.hostClass) return null;
      return selector.includes(opts.hostClass) ? host : null;
    },
  } as unknown as Element;
}

describe('isDropdownFilterInput', () => {
  it('没有下拉宿主 → 不是下拉过滤框', () => {
    expect(isDropdownFilterInput(makeEl({}))).toBe(false);
  });

  it('Element UI select 面板展开（visible=true）→ 是', () => {
    expect(isDropdownFilterInput(makeEl({ hostClass: 'el-select', vue: { visible: true } }))).toBe(true);
  });

  it('Element UI select 面板收起（visible=false）→ 不是', () => {
    expect(isDropdownFilterInput(makeEl({ hostClass: 'el-select', vue: { visible: false } }))).toBe(false);
  });

  it('Element UI autocomplete 候选展开（suggestionsVisible=true）→ 是', () => {
    expect(
      isDropdownFilterInput(makeEl({ hostClass: 'el-autocomplete', vue: { suggestionsVisible: true } })),
    ).toBe(true);
  });

  it('Ant Design 无 __vue__ 时看 class：ant-select-open → 是', () => {
    expect(
      isDropdownFilterInput(
        makeEl({ hostClass: 'ant-select', className: 'ant-select ant-select-open' }),
      ),
    ).toBe(true);
  });

  it('Ant Design 无 __vue__ 且 class 无 -open → 不是', () => {
    expect(isDropdownFilterInput(makeEl({ hostClass: 'ant-select' }))).toBe(false);
  });

  it('有 __vue__ 时以它为准（closed 优先于 class 的 -open 残留）', () => {
    expect(
      isDropdownFilterInput(
        makeEl({ hostClass: 'el-select', className: 'el-select is-open', vue: { visible: false } }),
      ),
    ).toBe(false);
  });
});

describe('isOpenDropdownFilter', () => {
  it('委派给 isDropdownFilterInput', async () => {
    const loc = {
      evaluate: async (fn: (el: Element) => boolean) => fn(makeEl({ hostClass: 'el-select', vue: { visible: true } })),
    } as unknown as Locator;
    expect(await isOpenDropdownFilter(loc)).toBe(true);
  });

  it('元素脱离 DOM / 定位失败 → 按「不是」处理（照常 blur）', async () => {
    const loc = {
      evaluate: async () => {
        throw new Error('detached');
      },
    } as unknown as Locator;
    expect(await isOpenDropdownFilter(loc)).toBe(false);
  });
});
