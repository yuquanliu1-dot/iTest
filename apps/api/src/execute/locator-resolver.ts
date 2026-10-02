import type { Page } from 'playwright-core';
import type { Locator, IntentLocator } from '@itest/shared';
import { isStableCssPath } from '@itest/recorder/modules/selector-filter.js';

export interface ResolverInput {
  locator: Locator[];
  intentLocator?: IntentLocator;
}

/** 单段 CSS 是否为「纯 #id 形式且 id 非动态」——满足则提升优先级。 */
function isPureStableCss(value: string): boolean {
  // value 形如 'tag#id' 或 '#id'
  if (!value.includes('#')) return false;
  // 整段必须只含一个 #id，且 id 部分不命中运行时模式
  return isStableCssPath(value);
}

/**
 * 三层定位候选构造（顺序固定）：
 *   1. intentLocator.semanticRole（作为 data-testid 候选）
 *   2. intentLocator.contextText（文本兜底）
 *   3. 稳定 #id CSS（纯 #id 形式）
 *   4. XPath
 *   5. 普通 CSS / role / text / testId（按出现顺序）
 *
 * 返回值是 playwright Locator 数组 + 标记信息。失败回退由调用方 tryEach 决定。
 */
export function buildCandidates(page: Page, action: ResolverInput): Array<{ kind: string; loc: ReturnType<Page['locator']> }> {
  const out: Array<{ kind: string; loc: ReturnType<Page['locator']> }> = [];
  const seen = new Set<unknown>();

  const push = (kind: string, l: ReturnType<Page['locator']>) => {
    if (seen.has(l)) return;
    seen.add(l);
    out.push({ kind, loc: l });
  };

  // 1+2: intent
  if (action.intentLocator) {
    if (action.intentLocator.semanticRole) {
      push('intent-testid', page.locator(`[data-testid="${action.intentLocator.semanticRole}"]`));
    }
    if (action.intentLocator.contextText) {
      push('intent-text', page.getByText(action.intentLocator.contextText));
    }
  }

  // 3+4+5: 稳定 #id CSS 在前，XPath 与普通 CSS / role / text / testId 在后，按输入顺序
  // 注意：稳定 #id 在最前是为了让一级 CSS 失败时能立刻回落到稳定的 #id，避免不必要的 XPath / 普通 CSS 重试。
  for (const l of action.locator) {
    if (l.strategy === 'css' && isPureStableCss(l.value)) {
      push('stable-css', page.locator(l.value));
    }
  }

  for (const l of action.locator) {
    if (l.strategy === 'css' && !isPureStableCss(l.value)) {
      push('css', page.locator(l.value));
    }
    if (l.strategy === 'xpath') {
      push('xpath', page.locator(`xpath=${l.value}`));
    }
    if (l.strategy === 'role') {
      const m = l.value.match(/^([\w-]+)(?:\[name="([^"]*)"\]|\[name='([^']*)'\])$/);
      if (m) {
        const [, role, name1, name2] = m;
        push('role', page.getByRole(role as never, { name: name1 ?? name2 ?? undefined }));
        // 无 name 兜底：role 单独匹配可能命中多个元素（strict mode violation）。
        // 给出「role + 无 name」候选，让 tryFirstMatch 用 count() 探测，避免 fill 阶段才暴露。
        if (!name1 && !name2) push('role-unnamed', page.getByRole(l.value as never));
      } else if (l.value.includes(' ')) {
        // 多段 role locator（"textbox 用户名"）——拆为 role + text 两段组合，分别探测。
        const parts = l.value.split(/\s+/);
        const role = parts[0]!;
        const text = parts.slice(1).join(' ');
        push('role-with-text', page.getByRole(role as never, { name: text }));
      } else {
        push('role', page.getByRole(l.value as never));
      }
    }
    if (l.strategy === 'text') {
      push('text', page.getByText(l.value));
    }
    if (l.strategy === 'testId') {
      const v = l.value.startsWith('[') ? l.value : `[data-testid="${l.value}"]`;
      push('testId', page.locator(v));
    }
  }

  return out;
}
