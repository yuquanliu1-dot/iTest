/**
 * 用例级视觉判定覆盖「需要滚动才能看到」的区域。
 *
 * 背景：page.screenshot() 默认就是视口截图，视口以下的内容根本进不了判定的图。
 * 而 CASE_OUTCOME_VISION_PROMPT 写着「空白页/加载中 → failed」，于是「关键区域在
 * 视口以下」与「页面真的坏了」在证据上不可区分，用例假失败（长表单/长列表的 SOC 页面高发）。
 *
 * 修法：文档确实溢出时补一张整页图，与视口图一起喂判定，并在 prompt 里说明以整页图为准。
 * 本测试锁两件事：
 *   1. 溢出 → 双图进 messages，且两个 image block 都在（图 2 真发了，不是只改文案）。
 *   2. 不溢出 → 单图，仍走 image 字段（短页面判定成本与改动前一致，零行为变化）。
 */
import { describe, it, expect } from 'vitest';
import type { LLMClient, LLMRequest, LLMResult } from '../src/agent/llm-client.js';
import { judgeCaseOutcome } from '../src/agent/judgeCaseOutcome.js';
import { CASE_OUTCOME_VISION_PROMPT } from '../src/agent/prompts/case-outcome-vision.js';

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
const countImages = (req: LLMRequest): number =>
  (req.messages ?? []).reduce((n, m) => n + m.content.filter((b) => b.type === 'image').length, 0)
  + (req.image ? 1 : 0);

describe('judgeCaseOutcome · 滚动区域的判定依据', () => {
  it('溢出页面：视口图 + 整页图两张都进 messages', async () => {
    const { llm, reqs } = mockLlm();
    await judgeCaseOutcome({
      expectedOutcome: '详情页表单区域与基本信息卡片正常展示',
      caseTitle: '规则查看',
      screenshot: shot('viewport'),
      fullScreenshot: shot('fullpage'),
      llmClient: llm,
    });
    expect(countImages(reqs[0]!)).toBe(2);
    // 走 messages 而非 image 字段：后者只支持单图
    expect(reqs[0]!.image).toBeUndefined();
  });

  it('两张图都被明确标注是「视口」和「整页」', async () => {
    const { llm, reqs } = mockLlm();
    await judgeCaseOutcome({
      expectedOutcome: 'x', caseTitle: 't',
      screenshot: shot('viewport'), fullScreenshot: shot('fullpage'),
      llmClient: llm,
    });
    const text = (reqs[0]!.messages ?? []).flatMap((m) => m.content)
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text).join('\n');
    expect(text).toContain('图 1');
    expect(text).toContain('视口');
    expect(text).toContain('图 2');
    expect(text).toContain('整页');
  });

  it('prompt 说明「视口看不到 ≠ 不存在」，避免长页面假失败', () => {
    expect(CASE_OUTCOME_VISION_PROMPT).toContain('图 2');
    expect(CASE_OUTCOME_VISION_PROMPT).toMatch(/以图 2 为准/);
    expect(CASE_OUTCOME_VISION_PROMPT).toContain('不要因为');
  });

  it('短页面不传 fullScreenshot → 仍单图，行为与改动前一致', async () => {
    const { llm, reqs } = mockLlm();
    await judgeCaseOutcome({
      expectedOutcome: '登录成功进入首页', caseTitle: 't',
      screenshot: shot('viewport'), llmClient: llm,
    });
    expect(countImages(reqs[0]!)).toBe(1);
    expect(reqs[0]!.image).toBeDefined();
    expect(reqs[0]!.messages).toBeUndefined();
  });

  it('expectedOutcome 为空 → 直接跳过，不调 LLM（与本改动无关的既有短路）', async () => {
    const { llm, reqs } = mockLlm();
    const r = await judgeCaseOutcome({
      expectedOutcome: '   ', caseTitle: 't',
      screenshot: shot('v'), fullScreenshot: shot('f'), llmClient: llm,
    });
    expect(r).toBeUndefined();
    expect(reqs).toHaveLength(0);
  });
});
