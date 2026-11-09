/**
 * 对话窗（AI 助手被测对象）场景的用例级 vision 判定规则。
 *
 * 背景：被测对象是对话窗 Agent（聊天输入框下发任务、AI 给回答）时，判定对象从
 * 「页面功能走到预期终点」变成「回答内容本身」——回应任务了吗 / 分析完成了吗 / 结论有据吗。
 * 两个特有失败形态必须由 prompt 硬规则约束（LLM 判定的语义边界只能写在 prompt 里）：
 *   1. 谎报完成：回答声称已创建/已修复/已执行，但过程证据里找不到痕迹 —— Agent 类
 *      被测对象最典型的失败形态（普通软件 SUT 没有这个形态），宁严勿宽。
 *   2. 编造：回答引用的编号/版本/数据与预期判据不一致或凭空出现 —— 引用事实可比对。
 * 另锁两条输入通道事实：回答原文以「执行过程页面文本」为主证据（对话消息在内滚容器里，
 * 终态/整页截图都只显示视口内的最后几条）；判定是事实锚点比对而非文风/深度评价。
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
    // 内滚容器截图局限：截图里看不到 ≠ 回答里没有，防「图里没有」假失败。
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
