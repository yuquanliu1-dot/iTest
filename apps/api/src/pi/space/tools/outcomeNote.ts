/**
 * expectedOutcome 自洽性体检（stage_case 新建 / stage_case_op 改预期共用）：
 *
 * verify 的终态判定（VisionAssertionFailed）只有一条软肋——expectedOutcome 断言了一个
 * 步骤根本不会产生的业务状态，终态判定必然落空，AI 又没有更好的过关手段，于是弱化预期
 * 蒙混通过。2026-10-13 prod228 实测：用例只做「进页面看列表」，expectedOutcome 却写
 * 「自动启动处置成功」；自动处置 tab 恒 0 条，三轮验证全败后 AI 把预期改成
 * 「页面正常加载」过关——用例被改成测不出东西，比失败更糟。
 *
 * 本模块把这类不自洽摆到**暂存那一刻**（而不是验证失败之后）：断言业务结果 + 步骤里却没有
 * 能产生该结果的操作 → 提示补造数步骤，或如实调整预期。
 *
 * 纯启发式、只提示不判死：步骤描述是自然语言，写法千变万化，误报把正确用例带偏比漏报更伤。
 */
import type { StepAction } from '@itest/shared';

/** 会改变服务端状态的操作动词——出现即认为本步骤自己造得出被断言的业务状态。
 *  刻意排除「处理/处置/分配」等在观察语境里同样高频的词：prod228 实测
 *  「查看工单处置状态」含「处置」，纳入会让观察型用例被误判为「会造数」。 */
const OP_VERB_RE = /新建|新增|创建|添加|录入|导入|上传|提交|保存|删除|移除|修改|编辑|更新|启用|禁用|停用|发布|撤回|撤销|重试|同步/;

/** expectedOutcome 断言了「某件事已发生」而非「页面能打开」。 */
const RESULT_RE = /成功|失败|生效|触发|已?生成|完成|变更|更新为|变更为|显示为|自动启动/;

/** 造数的另一种形态：mutating httpRequest（API 造数 → UI 验证）。 */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface OutcomeNoteInput {
  expectedOutcome: string | null | undefined;
  /** 步骤的自然语言描述（staged case 的 action / DB step 的 instruction）。 */
  stepActions: Array<string | null | undefined>;
  /** 步骤的 compiled，用于识别 httpRequest 造数。 */
  stepCompileds: Array<unknown>;
}

/** 步骤里是否有能产生业务状态的操作动作（操作动词 或 mutating httpRequest）。 */
function hasStateChangingAction(stepActions: string[], stepCompileds: unknown[]): boolean {
  if (stepActions.some((a) => typeof a === 'string' && OP_VERB_RE.test(a))) return true;
  return stepCompileds.some((compiled) =>
    (Array.isArray(compiled) ? compiled : []).some(
      (a) => MUTATING_METHODS.has(String((a as { method?: unknown })?.method ?? '').toUpperCase()),
    ),
  );
}

/**
 * 返回体检提示；无问题返回 null。
 * 只覆盖「预期断言了业务结果、步骤却造不出」这一种——最常见、危害最大的一类不自洽。
 */
export function buildOutcomeNote(input: OutcomeNoteInput): string | null {
  const outcome = typeof input.expectedOutcome === 'string' ? input.expectedOutcome.trim() : '';
  if (!outcome || !RESULT_RE.test(outcome)) return null;
  if (hasStateChangingAction(
    input.stepActions.filter((a): a is string => typeof a === 'string'),
    input.stepCompileds,
  )) return null;
  return [
    '预期体检:expectedOutcome 断言了业务结果「终态已达成」，但本用例步骤里没有会产生该结果的操作动作。',
    'verify_case 的终态判定必然落空，届时极易被「弱化 expectedOutcome 蒙混通过」——例如把「自动启动处置成功」改成「页面正常加载」，用例就此测不出东西。',
    '请二选一：(1) 补一步「先造出会触发该结果的数据」（如新建一条会自动触发处置的事件，可用 httpRequest 直接造数），再 verify_case；',
    '(2) 若本用例本质上只是观察、不产生该状态，就如实把 expectedOutcome 改成它真正能验证的东西。',
  ].join('');
}