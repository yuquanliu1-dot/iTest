import { describe, it, expect } from 'vitest';
import { materializeExpectedOutcome, maskSensitiveValues } from '../src/execute/cdp.js';
import type { LLMClient, LLMResult } from '../src/agent/llm-client.js';
import { judgeCaseOutcome } from '../src/agent/judgeCaseOutcome.js';

describe('materializeExpectedOutcome（行级预期物化）', () => {
  it('替换数据集列变量', () => {
    // 数据集列名受 validateVariableName 约束（ASCII 标识符），此处用合法列名
    expect(materializeExpectedOutcome('提交后页面应：{{expected_result}}', { expected_result: '登录框出现红色提示' }))
      .toBe('提交后页面应：登录框出现红色提示');
  });
  it('替换 extract 变量（未绑数据集同样受益）', () => {
    expect(materializeExpectedOutcome('订单号 {{orderNo}} 已显示', { orderNo: 'A123' })).toBe('订单号 A123 已显示');
  });
  it('未定义变量保留字面量（诚实失败）', () => {
    expect(materializeExpectedOutcome('应显示 {{ghost}}', {})).toBe('应显示 {{ghost}}');
  });
  it('报告侧脱敏：物化后文本落库前对敏感列值打码（LLM 提示按 §8.3 走明文）', () => {
    const vars = { password: 'pw-1', expected_result: '登录框出现红色提示' };
    const materialized = materializeExpectedOutcome('输入 {{password}} 后：{{expected_result}}', vars);
    expect(materialized).toBe('输入 pw-1 后：登录框出现红色提示');
    expect(maskSensitiveValues(materialized, vars, ['password'])).toBe('输入 ****** 后：登录框出现红色提示');
  });
});

/** 捕获 completeJson 实际发出请求的 lang 字段（provider 层的指令块追加无法在单测里 mock）。 */
describe('judgeCaseOutcome lang 接线（执行路径无用户上下文 → zh-CN 回落）', () => {
  function makeCaptureLlm() {
    const reqs: Array<{ lang?: string }> = [];
    const llm: LLMClient = {
      provider: 'anthropic',
      async complete(req): Promise<LLMResult> {
        reqs.push(req);
        return { kind: 'json', value: { passed: true, reason: '页面符合预期' }, provider: 'anthropic', vision: true };
      },
    };
    return { llm, reqs };
  }

  it('不传 lang → 请求 lang 回落 zh-CN', async () => {
    const { llm, reqs } = makeCaptureLlm();
    await judgeCaseOutcome({
      caseTitle: '登录',
      expectedOutcome: '页面出现登录成功',
      screenshot: { base64: 'x', mime: 'image/png' },
      llmClient: llm,
    });
    expect(reqs[0]!.lang).toBe('zh-CN');
  });

  it('传 lang=en-US → 请求 lang 透传', async () => {
    const { llm, reqs } = makeCaptureLlm();
    await judgeCaseOutcome({
      caseTitle: '登录',
      expectedOutcome: '页面出现登录成功',
      screenshot: { base64: 'x', mime: 'image/png' },
      llmClient: llm,
      lang: 'en-US',
    });
    expect(reqs[0]!.lang).toBe('en-US');
  });
});
