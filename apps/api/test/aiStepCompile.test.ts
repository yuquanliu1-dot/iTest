import { describe, it, expect } from 'vitest';
import { compileAiStep, compileAiStepsInPlace, compileAiStepVision } from '../src/agent/aiStepCompile.js';
import type { LLMClient, LLMRequest, LLMResult } from '../src/agent/llm-client.js';

const fakeClient = (outputs: { steps?: unknown }[]): LLMClient => ({
  provider: 'mock',
  complete: async () => {
    const v = outputs.shift();
    return v
      ? { kind: 'json', value: v as Record<string, unknown>, provider: 'mock', vision: false }
      : { kind: 'text', value: '', provider: 'mock', vision: false };
  },
});

describe('compileAiStep', () => {
  it('returns parsed steps on valid LLM output', async () => {
    const client = fakeClient([
      { steps: [{ kind: 'waitFor', locator: [{ strategy: 'role', value: 'main' }] }] },
    ]);
    const out = await compileAiStep('等待主区域出现', {}, client);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('waitFor');
  });

  it('retries once with hint when first output is invalid, then succeeds', async () => {
    const client = fakeClient([
      { steps: [{ kind: 'fly-to-moon' }] },
      { steps: [{ kind: 'assertVisible', locator: [{ strategy: 'role', value: 'main' }] }] },
    ]);
    const out = await compileAiStep('x', {}, client);
    expect(out[0]!.kind).toBe('assertVisible');
  });

  it('drops invalid items but keeps valid ones', async () => {
    const client = fakeClient([
      { steps: [{ kind: 'bogus' }, { kind: 'click', locator: [{ strategy: 'text', value: 'OK' }] }] },
    ]);
    const out = await compileAiStep('x', {}, client);
    expect(out.map((s) => s.kind)).toEqual(['click']);
  });

  it('throws after two invalid attempts', async () => {
    const client = fakeClient([{ steps: 'nope' }, { steps: 'nope' }]);
    await expect(compileAiStep('x', {}, client)).rejects.toThrow(/编译失败/);
  });
});

describe('compileAiStepsInPlace', () => {
  it('compiles aiStep actions in place and reports failed indices', async () => {
    let calls = 0;
    const client: LLMClient = {
      provider: 'mock',
      complete: async () => {
        calls++;
        if (calls === 1) return { kind: 'json', value: { steps: [{ kind: 'waitFor', locator: [{ strategy: 'role', value: 'main' }] }] }, provider: 'mock', vision: false };
        return { kind: 'text', value: 'garbage', provider: 'mock', vision: false };
      },
    };
    const steps = [
      { action: { kind: 'aiStep', instruction: 'ok', compiled: null } },
      { action: { kind: 'aiStep', instruction: 'bad', compiled: null } },
      { action: { kind: 'click', locator: [{ strategy: 'text', value: 'OK' }] } },
    ];
    const failed = await compileAiStepsInPlace(steps, client);
    expect(failed).toEqual([1]);
    expect((steps[0]!.action as { compiled: unknown[] }).compiled).toHaveLength(1);
    expect((steps[1]!.action as { compiled: unknown }).compiled).toBeNull();
  });
});

describe('LLMClient shape — vision support', () => {
  it('LLMRequest accepts optional image', () => {
    const req: LLMRequest = {
      systemPrompt: 's',
      userMessage: 'u',
      image: { base64: 'AAA=', mime: 'image/png' },
    };
    expect(req.image?.mime).toBe('image/png');
  });

  it('LLMResult exposes vision flag', () => {
    const r: LLMResult = { kind: 'text', value: 'x', provider: 'mock', vision: false };
    expect(r.vision).toBe(false);
  });
});

describe('compileAiStep — fallback on empty instruction', () => {
  it('uses step.name when instruction is empty', async () => {
    let captured = '';
    const client: LLMClient = {
      provider: 'mock',
      complete: async (req) => {
        captured = req.userMessage;
        return {
          kind: 'json',
          value: { steps: [{ kind: 'waitFor', locator: [{ strategy: 'role', value: 'main' }] }] },
          provider: 'mock',
          vision: false,
        };
      },
    };
    const out = await compileAiStep('', { name: '点击保存' }, client);
    expect(out).toHaveLength(1);
    expect(captured).toContain('点击保存');
    expect(captured).toContain('[fallback-by-name]');
  });

  it('throws when instruction empty and no name', async () => {
    const client: LLMClient = {
      provider: 'mock',
      complete: async () => ({ kind: 'text', value: '', provider: 'mock', vision: false }),
    };
    await expect(compileAiStep('', {}, client)).rejects.toThrow(/编译失败/);
  });
});

describe('compileAiStep — vision path', () => {
  it('forwards image to provider when placeholders are present', async () => {
    let captured: { image?: unknown; userMessage?: string } = {};
    const client: LLMClient = {
      provider: 'mock',
      complete: async (req) => {
        captured = { image: req.image, userMessage: req.userMessage };
        return {
          kind: 'text',
          value: '识别出的文本',
          provider: 'mock',
          vision: !!req.image,
        };
      },
    };
    const text = await compileAiStepVision(
      '识别图片 #captchaImg 并输入到 #captchaInput',
      { image: { base64: 'AAA=', mime: 'image/png' } },
      client,
    );
    expect(text).toBe('识别出的文本');
    expect(captured.image).toEqual({ base64: 'AAA=', mime: 'image/png' });
    expect(captured.userMessage).toContain('captchaInput');
  });
});
