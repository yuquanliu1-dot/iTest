/**
 * AI 动作 → compiled DSL 的机械映射：solidify_case（显式固化）与 aiTask 运行时缓存
 * （自动挡固化，见 aiTaskCache.ts）共用的下沉模块。execute 层不能反向依赖 pi 工具层，
 * 故从 pi/space/tools/solidifyCase.ts 搬到此处的同名函数为唯一实现。
 */
import type { Locator, StepAction } from '@itest/shared';
import { USER_PH, PASSWORD_PH, SECRET_PH, type AiAction } from './aiTask.js';

/** Playwright 专有语法（引擎链 / 伪类扩展），平台 css 策略不认识 → 不可映射。 */
export const PLAYWRIGHT_ONLY_SELECTOR_RE = />>|:has-text|:has\(|:near\(|:above\(|:below\(|engine=|nth=/i;

/** AI 动作选择器 → 平台 Locator；不可映射返回 null。 */
export function mapSelector(selector: string): Locator | null {
  const text = /^text=(.+)$/s.exec(selector);
  if (text) return { strategy: 'text', value: text[1]! };
  if (PLAYWRIGHT_ONLY_SELECTOR_RE.test(selector)) return null;
  return { strategy: 'css', value: selector };
}

export type SolidifyMapResult =
  | { ok: true; compiled: StepAction[]; skippedCount: number }
  | { ok: false; reason: string };

/**
 * 把一个 aiTask 步骤收集到的（成功）AI 动作序列机械映射为 compiled DSL。
 * 步骤级全有或全无：press / wait 无对应 DSL kind、选择器含 Playwright 专有语法、
 * fill value 是凭据占位符——任一出现即整步保持 aiTask（保守正确优于部分固化）。
 * screenshot 是观察性动作，跳过不映射。
 */
export function mapAiActionsToCompiled(actions: AiAction[]): SolidifyMapResult {
  const compiled: StepAction[] = [];
  let skippedCount = 0;
  for (const a of actions) {
    switch (a.type) {
      case 'click': {
        const locator = mapSelector(a.selector);
        if (!locator) return { ok: false, reason: `click 选择器 "${a.selector}" 含 Playwright 专有语法，无法映射为平台 locator` };
        compiled.push({ kind: 'click', locator: [locator] });
        break;
      }
      case 'fill': {
        if (a.value === USER_PH || a.value === PASSWORD_PH || a.value === SECRET_PH) {
          return { ok: false, reason: 'fill value 为登录/敏感凭据占位符（登录不属于用例步骤，归环境登录），不固化' };
        }
        const locator = mapSelector(a.selector);
        if (!locator) return { ok: false, reason: `fill 选择器 "${a.selector}" 含 Playwright 专有语法，无法映射为平台 locator` };
        compiled.push({ kind: 'fill', locator: [locator], value: a.value });
        break;
      }
      case 'navigate':
        compiled.push({ kind: 'navigate', url: a.url });
        break;
      case 'screenshot':
        skippedCount += 1; // 观察性动作（AI 自己看页面用），无副作用，不进 compiled
        break;
      case 'press':
        return { ok: false, reason: `含键盘动作 press(${a.key})，DSL 无对应机械动作，整步保持 aiTask` };
      case 'wait':
        return { ok: false, reason: `含时序动作 wait(${a.ms}ms)，DSL 无对应机械动作，整步保持 aiTask` };
    }
  }
  if (compiled.length === 0) {
    return { ok: false, reason: '无可映射动作（成功动作为空或全为观察性截图）' };
  }
  return { ok: true, compiled, skippedCount };
}
