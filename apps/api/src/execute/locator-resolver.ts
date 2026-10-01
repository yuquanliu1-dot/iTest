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

  // 3: 稳定 #id CSS
  for (const l of action.locator) {
    if (l.strategy === 'css' && isPureStableCss(l.value)) {
      push('stable-css', page.locator(l.value));
    }
  }

  // 4+5: XPath 与普通 CSS / role / text / testId，按输入顺序
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
