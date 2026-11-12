/**
 * expectedOutcome self-consistency check (shared by stage_case creation / stage_case_op expectation changes):
 *
 * verify's final-state judgment (VisionAssertionFailed) has only one soft spot — when expectedOutcome asserts a business
 * state the steps can never produce, the final-state judgment is guaranteed to miss, the AI has no better way to pass,
 * and so it waters down the expectation to sneak through. Measured on prod228 2026-10-13: the case only did "open the page
 * and look at the list", yet expectedOutcome said 「自动启动处置成功」; the auto-disposition tab stayed at 0 rows, and after
 * three failed verification rounds the AI changed the expectation to 「页面正常加载」 to pass — the case was rewritten into
 * something that tests nothing, which is worse than failing.
 *
 * This module surfaces such inconsistencies at the moment of staging (not after verification fails): asserting a business
 * result + no step capable of producing it → prompt to add a data-seeding step, or honestly adjust the expectation.
 *
 * Purely heuristic, advisory only, never a hard kill: step descriptions are natural language in endless varieties; a false
 * positive leading a correct case astray hurts more than a missed one. The 2026-10-29 dump1 field log added two exempted shapes:
 * (1) steps using sendSyslog/sql/observeLog-style protocol steps to produce or capture SUT state (a syslog event by itself can
 * trigger SUT side-effects); the old rule only recognized UI verbs and mutating http, misreporting such cases as "cannot produce
 * the state"; (2) expectations that are themselves purely observational (page reachable / element visible), where "cannot produce"
 * doesn't even apply.
 */
import type { StepAction } from '@itest/shared';

/** Operation verbs that change server-side state — presence means the step can itself produce the asserted business state.
 *  Deliberately excludes words like 「处理/处置/分配」 that are equally frequent in observational contexts: measured on prod228,
 *  「查看工单处置状态」 contains 「处置」; including it would misjudge observational cases as "will seed data". */
const OP_VERB_RE = /新建|新增|创建|添加|录入|导入|上传|提交|保存|删除|移除|修改|编辑|更新|启用|禁用|停用|发布|撤回|撤销|重试|同步/;

/** expectedOutcome asserts "something has happened" rather than "the page can be opened". */
const RESULT_RE = /成功|失败|生效|触发|已?生成|完成|变更|更新为|变更为|显示为|自动启动/;

/** Another shape of data seeding: mutating httpRequest (seed via API → verify via UI). */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** compiled action kinds that produce or capture SUT state: sendSyslog writes events into the SUT (can trigger SIEM
 *  side-effects = the business result itself), sql can write the SUT database, observeLog verifies facts that already
 *  happened in the SUT (events produced by real traffic).
 *  httpRequest is not in this set: mutating or not is judged by method (GET is a read; MUTATING_METHODS already covers it). */
const EVIDENCE_KINDS: ReadonlySet<string> = new Set(['sendSyslog', 'sql', 'observeLog']);

/** Purely observational expectations (page reachable / element visible): "cannot produce" doesn't apply; not checked. */
const OBSERVATIONAL_OUTCOME_RE = /可达|可见|渲染|展示|显示|加载出|页面正常|正常打开/;

/** Strong business-result words: when co-occurring with observational words, no exemption (「列表可见且自动启动处置」 is still checked —
 *  guarding against the both-ends sneak shape of "water down to observational wording + keep the result word"). */
const STRONG_RESULT_RE = /生效|触发|已?生成|变更|更新为|变更为|显示为|自动启动/;

export interface OutcomeNoteInput {
  expectedOutcome: string | null | undefined;
  /** The step's natural-language description (a staged case's action / a DB step's instruction). */
  stepActions: Array<string | null | undefined>;
  /** The step's compiled, used to recognize httpRequest / protocol-step data seeding. */
  stepCompileds: Array<unknown>;
}

/** Whether the steps contain an operation action that can produce the business state (operation verbs / mutating httpRequest / protocol evidence steps). */
function hasStateChangingAction(stepActions: string[], stepCompileds: unknown[]): boolean {
  if (stepActions.some((a) => typeof a === 'string' && OP_VERB_RE.test(a))) return true;
  return stepCompileds.some((compiled) =>
    (Array.isArray(compiled) ? compiled : []).some((a) => {
      if (EVIDENCE_KINDS.has(String((a as { kind?: unknown })?.kind ?? ''))) return true;
      return MUTATING_METHODS.has(String((a as { method?: unknown })?.method ?? '').toUpperCase());
    }),
  );
}

/**
 * Returns the check note; null when there is no problem.
 * Covers only "the expectation asserts a business result but the steps cannot produce it" — the most common, most damaging kind of inconsistency.
 */
export function buildOutcomeNote(input: OutcomeNoteInput): string | null {
  const outcome = typeof input.expectedOutcome === 'string' ? input.expectedOutcome.trim() : '';
  if (!outcome || !RESULT_RE.test(outcome)) return null;
  // Purely observational expectations (observational words + no strong-result word) are not checked: they verify reachability/visibility and owe no "data seeding".
  if (OBSERVATIONAL_OUTCOME_RE.test(outcome) && !STRONG_RESULT_RE.test(outcome)) return null;
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