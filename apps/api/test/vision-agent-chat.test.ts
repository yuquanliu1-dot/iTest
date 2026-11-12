/**
 * Case-level vision judgment rules for the chat-window (AI assistant as SUT) scenario.
 *
 * Background: when the SUT is a chat-window Agent (tasks issued via a chat input box, AI answers back),
 * the judgment target shifts from 「页面功能走到预期终点」 to 「回答内容本身」 — did it respond to the task /
 * did the analysis finish / is the conclusion evidenced.
 * Two failure shapes unique to this SUT must be constrained by hard prompt rules (semantic boundaries
 * of LLM judgment can only be written into the prompt):
 *   1. False completion claims: the answer claims created/fixed/executed, but the action-trail evidence
 *      holds no trace — the most typical failure shape of Agent-type SUTs (plain software SUTs lack it);
 *      prefer strict over lenient.
 *   2. Fabrication: the number/version/data cited by the answer mismatches the expected criteria or
 *      appears out of thin air — cited facts are comparable.
 * Two input-channel facts are also pinned: the answer text is judged mainly against the 「执行过程页面文本」
 * snapshot (chat messages live in an inner-scroll container; final-state/full-page screenshots only show
 * the last few viewport-visible messages); judgment is factual anchor comparison, not style/depth review.
 */
import { describe, it, expect } from 'vitest';
import { CASE_OUTCOME_VISION_PROMPT } from '../src/agent/prompts/case-outcome-vision.js';

describe('prompt · 对话窗（Agent 被测对象）判定规则', () => {
  it('声明本节适用于对话/聊天界面，且冲突时以本节为准', () => {
    expect(CASE_OUTCOME_VISION_PROMPT).toMatch(/对话窗（AI 助手被测对象）的判定规则/);
    expect(CASE_OUTCOME_VISION_PROMPT).toMatch(/页面是聊天\/对话界面时按本节判定/);
    expect(CASE_OUTCOME_VISION_PROMPT).toMatch(/以本节为准/);
  });

  it('判定对象是回答内容本身，回答原文以过程页面文本为主证据（内滚截图局限写明）', () => {
    expect(CASE_OUTCOME_VISION_PROMPT).toMatch(/判定对象是「回答内容」本身/);
    expect(CASE_OUTCOME_VISION_PROMPT).toMatch(/执行过程页面文本」?\s*快照为主证据|以「执行过程页面文本」\s*快照为主证据/);
    // Inner-scroll container screenshot limitation: absent from the screenshot ≠ absent from the answer; guards against 「图里没有」 false failures.
    expect(CASE_OUTCOME_VISION_PROMPT).toMatch(/内部滚动容器/);
    expect(CASE_OUTCOME_VISION_PROMPT).toMatch(/不要因「图里没有」判失败/);
    expect(CASE_OUTCOME_VISION_PROMPT).toMatch(/过程文本里也没有的才算不存在/);
  });

  it('谎报完成判 failed —— 声称完成但无证据，宁严勿宽', () => {
    expect(CASE_OUTCOME_VISION_PROMPT).toMatch(/谎报完成判 failed/);
    expect(CASE_OUTCOME_VISION_PROMPT).toMatch(/声称已完成某操作/);
    expect(CASE_OUTCOME_VISION_PROMPT).toMatch(/找不到对应痕迹/);
    expect(CASE_OUTCOME_VISION_PROMPT).toMatch(/宁严勿宽/);
  });

  it('编造检测判 failed —— 引用事实与判据不一致/凭空出现', () => {
    expect(CASE_OUTCOME_VISION_PROMPT).toMatch(/编造检测判 failed/);
    expect(CASE_OUTCOME_VISION_PROMPT).toMatch(/与判据\s*不一致|不一致、或引用了判据与过程中都不存在/);
  });

  it('事实锚点比对而非文风/深度评价 —— 防判定面过宽把合格回答误杀', () => {
    expect(CASE_OUTCOME_VISION_PROMPT).toMatch(/事实锚点比对/);
    expect(CASE_OUTCOME_VISION_PROMPT).toMatch(/不是文风\/深度评价/);
    expect(CASE_OUTCOME_VISION_PROMPT).toMatch(/锚点确实缺失才算不符/);
  });
});
