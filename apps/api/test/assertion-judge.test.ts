import { describe, it, expect } from 'vitest';
import type { LLMClient, LLMResult } from '../src/agent/llm-client.js';
import { judgeAssertionText } from '../src/pi/space/tools/assertionJudge.js';

function makeMockLlm(script: Array<Record<string, unknown> | string>) {
  const requests: string[] = [];
  const llm: LLMClient = {
    provider: 'anthropic',
    async complete(req): Promise<LLMResult> {
      requests.push(req.userMessage);
      const raw = script.shift();
      if (raw === undefined) throw new Error('mock script exhausted');
      return typeof raw === 'string'
        ? { kind: 'text', value: raw, provider: 'anthropic', vision: true }
        : { kind: 'json', value: raw, provider: 'anthropic', vision: true };
    },
  };
  return { llm, requests };
}

describe('judgeAssertionText', () => {
  it('LLM 判为描述性短语 → real=false 并带回理由', async () => {
    const { llm } = makeMockLlm([{ real: false, reason: '描述状态而非页面文案' }]);
    const r = await judgeAssertionText('登录表单正常展示', '登录 页面上有登录按钮', llm);
    expect(r.real).toBe(false);
    expect(r.reason).toBe('描述状态而非页面文案');
  });

  it('LLM 判为真实 UI 文案 → real=true', async () => {
    const { llm } = makeMockLlm([{ real: true, reason: '按钮文案' }]);
    const r = await judgeAssertionText('登录', '登录 页面上有登录按钮', llm);
    expect(r.real).toBe(true);
  });

  it('页面文本与断言一起进 user message（判定依据是真实页面）', async () => {
    const { llm, requests } = makeMockLlm([{ real: true, reason: '' }]);
    await judgeAssertionText('验证码不合法', '登录 账号 密码 验证码不合法', llm);
    expect(requests[0]).toContain('断言文本：验证码不合法');
    expect(requests[0]).toContain('验证码不合法');
  });

  it('拿不到页面文本时明确告知 LLM（仍可按语义判断）', async () => {
    const { llm, requests } = makeMockLlm([{ real: true, reason: '' }]);
    await judgeAssertionText('登录成功', '', llm);
    expect(requests[0]).toContain('未取到页面文本');
  });

  it('LLM 抛错 → 保留断言（不静默丢弃用户的断言）', async () => {
    const { llm } = makeMockLlm([]);
    const r = await judgeAssertionText('登录表单正常展示', 'x', llm);
    expect(r.real).toBe(true);
    expect(r.reason).toContain('判定不可用');
  });

  it('LLM 返回非 JSON / 缺 real 字段 → 保留断言', async () => {
    const { llm } = makeMockLlm(['这不是 JSON']);
    const r = await judgeAssertionText('账号已触发锁定', 'x', llm);
    expect(r.real).toBe(true);
    expect(r.reason).toContain('不可解析');
  });

  it('页面文本超长时截断到 3000 字符', async () => {
    const { llm, requests } = makeMockLlm([{ real: true, reason: '' }]);
    await judgeAssertionText('保存', 'x'.repeat(9000), llm);
    const msg = requests[0]!;
    expect(msg).not.toContain('x'.repeat(3001));
  });
});
