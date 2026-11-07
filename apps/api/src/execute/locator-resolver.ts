import type { Page, Frame } from 'playwright-core';
import type { Locator, IntentLocator } from '@itest/shared';
import { isStableCssPath } from '@itest/recorder/modules/selector-filter.js';

export interface ResolverInput {
  locator: Locator[];
  intentLocator?: IntentLocator;
  /** 修复记忆候选（step_locator_cache）：追加到候选链末位兜底——作者候选链永远优先，
   *  缓存只在全链失败时参与探测；与作者候选重复（同 src）时跳过。 */
  repair?: Locator | null;
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
 * 返回值是 playwright Locator 数组 + 标记信息；src 为该候选的来源定位表达式
 * （同 strategy 多候选时 kind 反查不出具体哪条，src 供调用方展示/报错）。失败回退由调用方 tryEach 决定。
 * 候选探测通过 count()，避免后续动作（如 click）抛错；text/role 路径可能没有 count()，接受即成功。
 * 命中时把候选 kind/value 写入 hitSink（若提供），供 step 结果记录 hitLocator。
 * root 为 Page 或 Frame：Frame 与 Page 的 locator/getBy* 同签名（帧链步骤在帧上下文构造候选）。
 */
export function buildCandidates(
  root: Page | Frame,
  action: ResolverInput,
): Array<{ kind: string; loc: ReturnType<Page['locator']>; src?: string }> {
  const out: Array<{ kind: string; loc: ReturnType<Page['locator']>; src?: string }> = [];
  const seen = new Set<unknown>();

  const push = (kind: string, l: ReturnType<Page['locator']>, src?: string) => {
    if (seen.has(l)) return;
    seen.add(l);
    out.push({ kind, loc: l, src });
  };

  // 1+2: intent
  if (action.intentLocator) {
    if (action.intentLocator.semanticRole) {
      push('intent-testid', root.locator(`[data-testid="${action.intentLocator.semanticRole}"]`), `[data-testid="${action.intentLocator.semanticRole}"]`);
    }
    if (action.intentLocator.contextText) {
      push('intent-text', root.getByText(action.intentLocator.contextText), `text=${action.intentLocator.contextText}`);
    }
  }

  // 3+4+5: 稳定 #id CSS 在前，XPath 与普通 CSS / role / text / testId 在后，按输入顺序
  // 注意：稳定 #id 在最前是为了让一级 CSS 失败时能立刻回落到稳定的 #id，避免不必要的 XPath / 普通 CSS 重试。
  for (const l of action.locator) {
    if (l.strategy === 'css' && isPureStableCss(l.value)) {
      push('stable-css', root.locator(l.value), l.value);
    }
  }

  for (const l of action.locator) {
    if (l.strategy === 'css' && !isPureStableCss(l.value)) {
      push('css', root.locator(l.value), l.value);
    }
    if (l.strategy === 'xpath') {
      push('xpath', root.locator(`xpath=${l.value}`), l.value);
    }
    if (l.strategy === 'role') {
      const m = l.value.match(/^([\w-]+)(?:\[name="([^"]*)"\]|\[name='([^']*)'\])$/);
      if (m) {
        const [, role, name1, name2] = m;
        push('role', root.getByRole(role as never, { name: name1 ?? name2 ?? undefined }), l.value);
        // 无 name 兜底：role 单独匹配可能命中多个元素（strict mode violation）。
        // 给出「role + 无 name」候选，让 tryFirstMatch 用 count() 探测，避免 fill 阶段才暴露。
        if (!name1 && !name2) push('role-unnamed', root.getByRole(l.value as never), l.value);
      } else if (l.value.includes(' ')) {
        // 多段 role locator（"textbox 用户名"）——拆为 role + text 两段组合，分别探测。
        const parts = l.value.split(/\s+/);
        const role = parts[0]!;
        const text = parts.slice(1).join(' ');
        push('role-with-text', root.getByRole(role as never, { name: text }), l.value);
      } else {
        push('role', root.getByRole(l.value as never), l.value);
      }
    }
    if (l.strategy === 'text') {
      push('text', root.getByText(l.value), l.value);
    }
    if (l.strategy === 'testId') {
      const v = l.value.startsWith('[') ? l.value : `[data-testid="${l.value}"]`;
      push('testId', root.locator(v), l.value);
    }
  }

  // 6: 修复记忆候选（末位兜底）。kind='repair-cache' 供 tryFirstMatch 写 hitSink 时特判展示。
  if (action.repair) {
    const r = action.repair;
    const already = out.some((c) => c.src === r.value);
    if (!already) {
      if (r.strategy === 'css') push('repair-cache', root.locator(r.value), r.value);
      else if (r.strategy === 'xpath') push('repair-cache', root.locator(`xpath=${r.value}`), r.value);
      else if (r.strategy === 'text') push('repair-cache', root.getByText(r.value), r.value);
      else if (r.strategy === 'role') push('repair-cache', root.getByRole(r.value as never), r.value);
      else if (r.strategy === 'testId') {
        const v = r.value.startsWith('[') ? r.value : `[data-testid="${r.value}"]`;
        push('repair-cache', root.locator(v), r.value);
      }
    }
  }

  return out;
}
