/**
 * Mechanical mapping of AI actions → compiled DSL: a sunk-down module shared by solidify_case (explicit solidification)
 * and the aiTask runtime cache (automatic solidification, see aiTaskCache.ts). The execute layer must not depend back on the pi tool layer,
 * so the same-named function moved here from pi/space/tools/solidifyCase.ts is the sole implementation.
 */
import type { Locator, StepAction } from '@itest/shared';
import { credentialPlaceholderKind, type AiAction } from './aiTask.js';

/** Playwright-specific syntax (engine chains / pseudo-class extensions) the platform's css strategy doesn't understand → not mappable. */
export const PLAYWRIGHT_ONLY_SELECTOR_RE = />>|:has-text|:has\(|:near\(|:above\(|:below\(|engine=|nth=/i;

/** Bare-tag selectors (no #.[: or any other specificity, e.g. "span"/"button") always hit ambiguously within a page; after solidification, mechanical replay
 *  would silently click the wrong first visible hit — second line of defense (the synthesis-side uniqueness gate intercepts upstream; this intercepts regressions / external feed-ins). */
const BARE_TAG_RE = /^[a-z][a-z0-9-]*$/i;

/** "Active-state" selectors: classes like router-link-active / is-active that routing state dynamically adds/removes; at record time they hit
 *  only because the target menu **happens** to be active; at replay (deep link straight to the target page / an earlier step already switched menus) the class
 *  may not exist → solidification would surely break. 2026-10-28 prod228 record: 「进入 XX 菜单」 was solidified as
 *  a.router-link-exact-active.router-link-active. Second line of defense (synthesis-side already strips active-state classes;
 *  this intercepts regressions / external feed-ins); rejected outright during solidification mapping. */
export const ACTIVE_STATE_SELECTOR_RE = /router-link-(exact-)?active|\.is-active(?![\w-])/i;

/** Whether the step is visual mode (a solidification candidate): uncompiled (pure instruction) or compiled consisting entirely of aiTask.
 *  Originally defined in solidifyCase.ts; verify_case trajectory collection also needs it, so it sank to the neutral execute layer to avoid tool-to-tool reverse dependencies. */
export function isVisualStep(step: { instruction: string | null; compiled: unknown; sensitive: boolean }): boolean {
  if (step.sensitive) return false; // sensitive-step credentials never enter compiled, kept as-is
  const compiled = Array.isArray(step.compiled) ? step.compiled : [];
  if (compiled.length === 0) {
    return typeof step.instruction === 'string' && step.instruction.trim().length > 0;
  }
  return compiled.every((a) => (a as { kind?: string }).kind === 'aiTask');
}

/** AI action selector → platform Locator; returns null when not mappable. */
export function mapSelector(selector: string): Locator | null {
  const text = /^text=(.+)$/s.exec(selector);
  if (text) return { strategy: 'text', value: text[1]! };
  // Trailing :has-text("Y") (the pseudo-class decorates the target element itself, e.g. button:has-text("查询")) → text locator.
  // The css prefix narrowing is dropped; the multi-hit risk is covered by the acceptance static-analysis "源码命中多处" warning as fallback;
  // :has-text in the middle of a selector (div:has-text("x") input, target is input) doesn't preserve semantics, still rejected as proprietary syntax.
  const hasText = /^(.*):has-text\(\s*(['"])(.+?)\2\s*\)\s*$/.exec(selector);
  if (hasText) return { strategy: 'text', value: hasText[3]! };
  if (PLAYWRIGHT_ONLY_SELECTOR_RE.test(selector)) return null;
  return { strategy: 'css', value: selector };
}

/**
 * mapSelector + the same solidification defenses (active-state class / css bare-tag rejection) consolidated:
 * for reuse by writers that bypass mapAiActionsToCompiled, such as the locator repair memory (cdp.ts fallback path),
 * preventing fragile selectors like a.router-link-active that would surely break at replay from being frozen into the cache (2026-10-28 prod228 record).
 */
export function mapSelectorStrict(selector: string): Locator | null {
  if (ACTIVE_STATE_SELECTOR_RE.test(selector)) return null;
  const locator = mapSelector(selector);
  if (!locator) return null;
  if (locator.strategy === 'css' && BARE_TAG_RE.test(locator.value)) return null;
  return locator;
}

export type SolidifyMapResult =
  | { ok: true; compiled: StepAction[]; skippedCount: number }
  | { ok: false; reason: string };

/**
 * Mechanically maps a (successful) AI action sequence collected by an aiTask step into compiled DSL.
 * Step-level all-or-nothing: press has no DSL kind counterpart, the selector contains Playwright proprietary syntax,
 * the fill value is a credential placeholder — any one occurrence keeps the whole step as aiTask (conservatively correct beats partial solidification).
 * wait has a counterpart: mapped to waitFor with empty locator + timeoutMs (cdp's empty-locator waitFor branch
 * is exactly the fixed "sleep through timeoutMs" wait), so the AI phase's page-settling waits survive mechanically — in prod228 measurements,
 * a wait(1500ms) wedged after a click once caused the whole step (including that real click) to be dropped, zeroing the solidification rate.
 * screenshot is an observational action; skipped, not mapped.
 * Pure-observation steps (only wait/screenshot, no click/fill/navigate) are rejected wholesale: a lone waitFor([])
 * is "blind waiting disguised as solidification" (prod228 2026-10-23 measurement), zero semantic value that also crowds out real steps' aiTask-ization.
 */
export function mapAiActionsToCompiled(actions: AiAction[]): SolidifyMapResult {
  const compiled: StepAction[] = [];
  let skippedCount = 0;
  let realCount = 0; // click/fill/navigate counter: real interaction actions, as opposed to wait/screenshot observational actions
  for (const a of actions) {
    switch (a.type) {
      case 'click': {
        // Coordinate action not resolved back to a selector (element resolution failed at the execution point) → cannot be mechanically solidified; whole step stays aiTask.
        if (!a.selector) return { ok: false, reason: 'click 为坐标动作且未解析回稳定选择器，无法映射为平台 locator' };
        if (ACTIVE_STATE_SELECTOR_RE.test(a.selector)) {
          return { ok: false, reason: `click 选择器 "${a.selector}" 是激活态 class（由路由状态动态加减，回放时会因菜单未激活而落空），整步保持 aiTask` };
        }
        const locator = mapSelector(a.selector);
        if (!locator) return { ok: false, reason: `click 选择器 "${a.selector}" 含 Playwright 专有语法，无法映射为平台 locator` };
        if (locator.strategy === 'css' && BARE_TAG_RE.test(locator.value)) {
          return { ok: false, reason: `click 选择器 "${a.selector}" 特异性不足（裸标签必歧义），整步保持 aiTask` };
        }
        compiled.push({ kind: 'click', locator: [locator] });
        realCount += 1;
        break;
      }
      case 'fill': {
        // Credential placeholders in any form (sentinel / curly-brace variants {{ITEST_USERNAME}} / @服务名 attribution form) are never solidified —
        // solidification would freeze the literal into compiled; at replay valueSub recognizes it but the literal carries no credential,
        // and the attribution breaks when the environment changes. Conservatively keep the whole step as aiTask.
        if (credentialPlaceholderKind(a.value)) {
          return { ok: false, reason: 'fill value 为登录/敏感凭据占位符（含 @服务名 归属形态，登录不属于用例步骤，归环境登录），不固化' };
        }
        if (!a.selector) return { ok: false, reason: 'fill 为坐标动作且未解析回稳定选择器，无法映射为平台 locator' };
        if (ACTIVE_STATE_SELECTOR_RE.test(a.selector)) {
          return { ok: false, reason: `fill 选择器 "${a.selector}" 是激活态 class（由路由状态动态加减，回放时会因菜单未激活而落空），整步保持 aiTask` };
        }
        const locator = mapSelector(a.selector);
        if (!locator) return { ok: false, reason: `fill 选择器 "${a.selector}" 含 Playwright 专有语法，无法映射为平台 locator` };
        if (locator.strategy === 'css' && BARE_TAG_RE.test(locator.value)) {
          return { ok: false, reason: `fill 选择器 "${a.selector}" 特异性不足（裸标签必歧义），整步保持 aiTask` };
        }
        compiled.push({ kind: 'fill', locator: [locator], value: a.value });
        realCount += 1;
        break;
      }
      case 'navigate':
        compiled.push({ kind: 'navigate', url: a.url });
        realCount += 1;
        break;
      case 'screenshot':
        skippedCount += 1; // observational action (the AI looks at the page itself), no side effects, not in compiled
        break;
      case 'press':
        // The AI's press is a page-level keyboard action (page.keyboard.press, no element locator); it cannot map to the locator-bearing press DSL.
        return { ok: false, reason: `含键盘动作 press(${a.key})（页面级键盘、无元素定位），整步保持 aiTask` };
      case 'sql':
        // Database evidence actions (exploration-session-only channel) have no mechanical DSL counterpart: cannot be solidified into replay steps.
        return { ok: false, reason: '含数据库取证动作（只读查询），无对应机械 DSL，整步保持 aiTask' };
      case 'repo':
        // Repo code-reading actions (exploration-session-only channel) likewise: evidentiary in nature, no mechanical DSL counterpart, whole step stays aiTask.
        return { ok: false, reason: '含仓库读码动作（只读取证），无对应机械 DSL，整步保持 aiTask' };
      case 'wait':
        // The AI phase's page-settling wait maps to a fixed-duration waitFor (empty locator = wait for no element, sleep through timeoutMs)
        compiled.push({ kind: 'waitFor', locator: [], timeoutMs: a.ms });
        break;
    }
  }
  if (realCount === 0) {
    return { ok: false, reason: '无可映射动作（成功动作为空，或仅等待/截图类观察性动作，无真实交互）' };
  }
  return { ok: true, compiled, skippedCount };
}
