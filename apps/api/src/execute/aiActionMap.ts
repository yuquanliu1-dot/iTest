/**
 * AI 动作 → compiled DSL 的机械映射：solidify_case（显式固化）与 aiTask 运行时缓存
 * （自动挡固化，见 aiTaskCache.ts）共用的下沉模块。execute 层不能反向依赖 pi 工具层，
 * 故从 pi/space/tools/solidifyCase.ts 搬到此处的同名函数为唯一实现。
 */
import type { Locator, StepAction } from '@itest/shared';
import { credentialPlaceholderKind, type AiAction } from './aiTask.js';

/** Playwright 专有语法（引擎链 / 伪类扩展），平台 css 策略不认识 → 不可映射。 */
export const PLAYWRIGHT_ONLY_SELECTOR_RE = />>|:has-text|:has\(|:near\(|:above\(|:below\(|engine=|nth=/i;

/** 步骤是否为视觉模式（可固化候选）：未编译（纯 instruction）或 compiled 全部由 aiTask 组成。
 *  原 solidifyCase.ts 定义；verify_case 轨迹收集也要用，下沉到 execute 中性层避免工具间反向依赖。 */
export function isVisualStep(step: { instruction: string | null; compiled: unknown; sensitive: boolean }): boolean {
  if (step.sensitive) return false; // 敏感步骤凭据不进 compiled，保持原样
  const compiled = Array.isArray(step.compiled) ? step.compiled : [];
  if (compiled.length === 0) {
    return typeof step.instruction === 'string' && step.instruction.trim().length > 0;
  }
  return compiled.every((a) => (a as { kind?: string }).kind === 'aiTask');
}

/** AI 动作选择器 → 平台 Locator；不可映射返回 null。 */
export function mapSelector(selector: string): Locator | null {
  const text = /^text=(.+)$/s.exec(selector);
  if (text) return { strategy: 'text', value: text[1]! };
  // 尾缀 :has-text("Y")（伪类修饰目标元素本身，如 button:has-text("查询")）→ 文本定位。
  // 丢掉 css 前缀收窄，多命中风险由验收静态分析「源码命中多处」告警兜底；
  // :has-text 出现在选择器中段（div:has-text("x") input，目标是 input）语义不保真，仍按专有语法拒绝。
  const hasText = /^(.*):has-text\(\s*(['"])(.+?)\2\s*\)\s*$/.exec(selector);
  if (hasText) return { strategy: 'text', value: hasText[3]! };
  if (PLAYWRIGHT_ONLY_SELECTOR_RE.test(selector)) return null;
  return { strategy: 'css', value: selector };
}

export type SolidifyMapResult =
  | { ok: true; compiled: StepAction[]; skippedCount: number }
  | { ok: false; reason: string };

/**
 * 把一个 aiTask 步骤收集到的（成功）AI 动作序列机械映射为 compiled DSL。
 * 步骤级全有或全无：press 无对应 DSL kind、选择器含 Playwright 专有语法、
 * fill value 是凭据占位符——任一出现即整步保持 aiTask（保守正确优于部分固化）。
 * wait 有对应形态：映射为 waitFor 空 locator + timeoutMs（cdp 的 waitFor 空 locator 分支
 * 即「睡满 timeoutMs」的固定等待），AI 相的页面稳定等待因此可机械保留——prod228 实测里
 * click 后夹带的 wait(1500ms) 曾让整步（含那个真 click）被丢弃，固化率归零。
 * screenshot 是观察性动作，跳过不映射。
 * 纯观察步（只有 wait/screenshot，无任何 click/fill/navigate）整体拒绝：waitFor([]) 独苗
 * 是「盲等伪装成固化」（prod228 2026-10-23 实测），语义价值为零还挤掉真步骤的 aiTask 化。
 */
export function mapAiActionsToCompiled(actions: AiAction[]): SolidifyMapResult {
  const compiled: StepAction[] = [];
  let skippedCount = 0;
  let realCount = 0; // click/fill/navigate 计数：真实交互动作，区别于 wait/screenshot 观察性动作
  for (const a of actions) {
    switch (a.type) {
      case 'click': {
        const locator = mapSelector(a.selector);
        if (!locator) return { ok: false, reason: `click 选择器 "${a.selector}" 含 Playwright 专有语法，无法映射为平台 locator` };
        compiled.push({ kind: 'click', locator: [locator] });
        realCount += 1;
        break;
      }
      case 'fill': {
        // 任意形态的凭据占位符（哨兵 / 花括号变体 {{ITEST_USERNAME}} / @服务名 归属形态）都不固化——
        // 固化会把字面量冻结进 compiled，回放时 valueSub 认得但字面量里没有凭据，
        // 且换环境后归属失效。保守整步保持 aiTask。
        if (credentialPlaceholderKind(a.value)) {
          return { ok: false, reason: 'fill value 为登录/敏感凭据占位符（含 @服务名 归属形态，登录不属于用例步骤，归环境登录），不固化' };
        }
        const locator = mapSelector(a.selector);
        if (!locator) return { ok: false, reason: `fill 选择器 "${a.selector}" 含 Playwright 专有语法，无法映射为平台 locator` };
        compiled.push({ kind: 'fill', locator: [locator], value: a.value });
        realCount += 1;
        break;
      }
      case 'navigate':
        compiled.push({ kind: 'navigate', url: a.url });
        realCount += 1;
        break;
      case 'screenshot':
        skippedCount += 1; // 观察性动作（AI 自己看页面用），无副作用，不进 compiled
        break;
      case 'press':
        return { ok: false, reason: `含键盘动作 press(${a.key})，DSL 无对应机械动作，整步保持 aiTask` };
      case 'wait':
        // AI 相的页面稳定等待映射为固定时长 waitFor（空 locator = 不等元素，睡满 timeoutMs）
        compiled.push({ kind: 'waitFor', locator: [], timeoutMs: a.ms });
        break;
    }
  }
  if (realCount === 0) {
    return { ok: false, reason: '无可映射动作（成功动作为空，或仅等待/截图类观察性动作，无真实交互）' };
  }
  return { ok: true, compiled, skippedCount };
}
