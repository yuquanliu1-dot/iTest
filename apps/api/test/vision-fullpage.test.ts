/**
 * Case-level vision judgment covers regions 「需要滚动才能看到」 (requiring scrolling to be seen).
 *
 * Background: page.screenshot() is a viewport screenshot by default — content below the viewport never
 * enters the judgment image. And CASE_OUTCOME_VISION_PROMPT says 「空白页/加载中 → failed」, so 「关键区域
 * 在视口以下」 (key region below the fold) and 「页面真的坏了」 (page genuinely broken) are
 * indistinguishable from the evidence → false case failures (frequent on SOC pages with long
 * forms/long lists).
 *
 * Fix: when the document truly overflows, attach a full-page image alongside the viewport image for
 * judgment, and state in the prompt that the full-page image takes precedence.
 * This test pins two things:
 *   1. Overflow → both images enter messages, with both image blocks present (图 2 is really sent,
 *      not just copy changed).
 *   2. No overflow → single image, still via the image field (short-page judgment cost unchanged,
 *      zero behavior change).
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
    // Goes through messages rather than the image field: the latter supports only a single image
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
