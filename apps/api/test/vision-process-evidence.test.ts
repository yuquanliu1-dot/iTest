/**
 * 用例级 vision 判定的过程证据（图 3 + 过程页面文本）。
 *
 * 背景：waitForPageSettled 等页面静默后才截终态图，而 toast 自动消失本身就是一次像素
 * 变化——判定时刻 toast 必已从 DOM 卸载。若 expectedOutcome 写了「出现 XX 提示」，
 * 终态截图里必然没有 → 必现假失败。这是时序问题不是模态问题（AI-DOM 终态检查同样救不了）。
 *
 * 修法：把「过程证据」喂给同一次判定——末步截图（截自动作刚完成时，短时提示尚在存活
 * 窗口内）+ 每步机械捕获的页面文本快照（DOM 文字，确定性代码采集，不加新 AI 环节）。
 * 本测试锁五件事：
 *   1. 过程图 + 终态图都进 messages，图 1/2/3 标注齐全（真发了，不是只改文案）。
 *   2. 只有过程图没有整页图时也走 messages（image 字段只支持单图）。
 *   3. 过程文本快照作为文本块进消息，内容原样可达。
 *   4. prompt 写明「瞬时现象以图 3/过程文本为准；稳定终态仍以图 1/2 为准」的边界，
 *      防过程证据把真失败洗白（OR 短路的假通过风险用 prompt 规则约束）。
 *   5. 步骤执行记录（每步 warning/error）作为第三路过程证据——toast 可能出现在某步执行
 *      过程中、又在该步结束前消失（AI 降级重做耗时数十秒时尤甚），只有当时的执行者记进了备注。
 */
import { describe, it, expect } from 'vitest';
import type { LLMClient, LLMRequest, LLMResult } from '../src/agent/llm-client.js';
import { judgeCaseOutcome } from '../src/agent/judgeCaseOutcome.js';
import { CASE_OUTCOME_VISION_PROMPT } from '../src/agent/prompts/case-outcome-vision.js';
import { processScreenshotDiskPath } from '../src/execute/visionAssert.js';

function mockLlm(): { llm: LLMClient; reqs: LLMRequest[] } {
  const reqs: LLMRequest[] = [];
  const llm: LLMClient = {
    provider: 'anthropic',
    async complete(req): Promise<LLMResult> {
      reqs.push(req);
      return { kind: 'json', value: { passed: true, reason: 'ok' }, provider: 'anthropic', vision: true };
    },
  };
  return { llm, reqs };
}

const shot = (tag: string) => ({ base64: Buffer.from(tag).toString('base64'), mime: 'image/png' as const });
const blocks = (req: LLMRequest) => (req.messages ?? []).flatMap((m) => m.content);
const countImages = (req: LLMRequest): number =>
  blocks(req).filter((b) => b.type === 'image').length + (req.image ? 1 : 0);
const textOf = (req: LLMRequest): string =>
  blocks(req).filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join('\n');

describe('judgeCaseOutcome · 过程证据进判定', () => {
  it('视口 + 整页 + 过程图三张都进 messages，标注齐全', async () => {
    const { llm, reqs } = mockLlm();
    await judgeCaseOutcome({
      expectedOutcome: '提交后出现「保存成功」提示',
      caseTitle: 't',
      screenshot: shot('viewport'),
      fullScreenshot: shot('fullpage'),
      processScreenshot: shot('process'),
      llmClient: llm,
    });
    expect(countImages(reqs[0]!)).toBe(3);
    expect(reqs[0]!.image).toBeUndefined();
    const text = textOf(reqs[0]!);
    expect(text).toContain('图 1');
    expect(text).toContain('图 2');
    expect(text).toContain('图 3');
    expect(text).toContain('最后一步刚完成时');
  });

  it('只有过程图（无整页图）也走 messages 双图形态', async () => {
    const { llm, reqs } = mockLlm();
    await judgeCaseOutcome({
      expectedOutcome: 'x', caseTitle: 't',
      screenshot: shot('viewport'),
      processScreenshot: shot('process'),
      llmClient: llm,
    });
    expect(countImages(reqs[0]!)).toBe(2);
    expect(reqs[0]!.image).toBeUndefined();
  });

  it('过程文本快照作为文本块进消息，内容与份数标注原样可达', async () => {
    const { llm, reqs } = mockLlm();
    await judgeCaseOutcome({
      expectedOutcome: '出现「操作成功」toast',
      caseTitle: 't',
      screenshot: shot('v'),
      processScreenshot: shot('p'),
      processPageTexts: ['系统管理 用户列表', '操作成功 系统管理 用户列表'],
      llmClient: llm,
    });
    const text = textOf(reqs[0]!);
    expect(text).toContain('执行过程页面文本');
    expect(text).toContain('共 2 份');
    expect(text).toContain('操作成功 系统管理 用户列表');
    expect(text).toContain('[快照 2]');
  });

  it('不传任何过程证据 → 单图 image 字段，行为与改动前一致', async () => {
    const { llm, reqs } = mockLlm();
    await judgeCaseOutcome({
      expectedOutcome: '登录成功进入首页', caseTitle: 't',
      screenshot: shot('viewport'), llmClient: llm,
    });
    expect(countImages(reqs[0]!)).toBe(1);
    expect(reqs[0]!.image).toBeDefined();
    expect(reqs[0]!.messages).toBeUndefined();
  });
  it('只有步骤执行记录（无附加图/文本快照）也走 messages，内容原样可达', async () => {
    const { llm, reqs } = mockLlm();
    await judgeCaseOutcome({
      expectedOutcome: '提交后出现「保存成功」提示', caseTitle: 't',
      screenshot: shot('v'),
      processStepNotes: ['第 2 步：点击登录后页面顶部出现「验证码不正确」提示，预期已达成'],
      llmClient: llm,
    });
    expect(reqs[0]!.image).toBeUndefined();
    expect(countImages(reqs[0]!)).toBe(1);
    const text = textOf(reqs[0]!);
    expect(text).toContain('步骤执行记录');
    expect(text).toContain('第 2 步：点击登录后页面顶部出现「验证码不正确」提示');
  });
});

describe('prompt · 过程证据的判定边界', () => {
  it('写明瞬时现象以图 3/过程文本/步骤执行记录为准', () => {
    expect(CASE_OUTCOME_VISION_PROMPT).toContain('图 3');
    expect(CASE_OUTCOME_VISION_PROMPT).toContain('瞬时');
    expect(CASE_OUTCOME_VISION_PROMPT).toMatch(/图 3、过程文本或步骤执行记录/);
  });
  it('写明稳定终态仍以图 1/图 2 为准——过程证据不能替代终态判定', () => {
    expect(CASE_OUTCOME_VISION_PROMPT).toMatch(/稳定终态/);
    expect(CASE_OUTCOME_VISION_PROMPT).toMatch(/不能替代终态判定/);
  });
});

describe('processScreenshotDiskPath · web 路径到磁盘路径', () => {
  it('/screenshots/ 前缀映射到 screenshots 目录下相对路径', () => {
    const p = processScreenshotDiskPath('/screenshots/abc-123/step-3.png');
    expect(p).toBeTruthy();
    expect(p!).toContain('screenshots');
    expect(p!.endsWith('abc-123/step-3.png')).toBe(true);
  });
  it('非本服务前缀一律拒绝（防路径注入）', () => {
    expect(processScreenshotDiskPath('/etc/passwd')).toBeNull();
    expect(processScreenshotDiskPath('screenshots/x.png')).toBeNull();
    expect(processScreenshotDiskPath('')).toBeNull();
  });
});
