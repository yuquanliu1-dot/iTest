import { describe, it, expect } from 'vitest';
import { compileAiStep, compileAiStepsBatch, compileAiStepsInPlace, compileAiStepVision } from '../src/agent/aiStepCompile.js';
import type { LLMClient, LLMRequest, LLMResult } from '../src/agent/llm-client.js';

const fakeClient = (outputs: { steps?: unknown }[]): LLMClient => ({
  provider: 'openai',
  complete: async () => {
    const v = outputs.shift();
    return v
      ? { kind: 'json', value: v as Record<string, unknown>, provider: 'openai', vision: false }
      : { kind: 'text', value: '', provider: 'openai', vision: false };
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
      provider: 'openai',
      complete: async () => {
        calls++;
        if (calls === 1) return { kind: 'json', value: { steps: [{ kind: 'waitFor', locator: [{ strategy: 'role', value: 'main' }] }] }, provider: 'openai', vision: false };
        return { kind: 'text', value: 'garbage', provider: 'openai', vision: false };
      },
    };
    // no compiled field on these — original behavior is "always try to compile"
    const steps = [
      { action: { kind: 'aiStep', instruction: 'ok' } },
      { action: { kind: 'aiStep', instruction: 'bad' } },
      { action: { kind: 'click', locator: [{ strategy: 'text', value: 'OK' }] } },
    ];
    const failed = await compileAiStepsInPlace(steps, client);
    expect(failed).toEqual([1]);
    expect((steps[0]!.action as { compiled: unknown[] }).compiled).toHaveLength(1);
    expect((steps[1]!.action as { compiled: unknown }).compiled).toBeNull();
  });

  it('batches instructions into a single LLM call', async () => {
    const userMessages: string[] = [];
    const client: LLMClient = {
      provider: 'openai',
      complete: async (req) => {
        userMessages.push(req.userMessage);
        return {
          kind: 'json',
          value: {
            results: [
              { index: 1, steps: [{ kind: 'click', locator: [{ strategy: 'text', value: '提交' }] }] },
            ],
          },
          provider: 'openai',
          vision: false,
        };
      },
    };
    // "打开登录页" 命中 navigate 启发式，直接出 navigate 不调 LLM；
    // "点击提交" 不命中启发式，走 LLM。
    const steps = [
      { action: { kind: 'aiStep', instruction: '打开登录页' } },
      { action: { kind: 'aiStep', instruction: '点击提交' } },
    ];
    const failed = await compileAiStepsInPlace(steps, client);
    expect(failed).toEqual([]);
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]).toContain('1. 指令: 点击提交');
    expect((steps[0]!.action as { compiled: unknown[] }).compiled).toEqual([
      { kind: 'navigate', url: 'http://localhost:5173/login' },
    ]);
    expect((steps[1]!.action as { compiled: unknown[] }).compiled).toEqual([
      { kind: 'click', locator: [{ strategy: 'text', value: '提交' }] },
    ]);
  });

  it('falls back to per-step compile for indices missing from batch result', async () => {
    let calls = 0;
    const client: LLMClient = {
      provider: 'openai',
      complete: async () => {
        calls++;
        if (calls === 1) {
          // 批量调用：只回了第 1 条，第 2 条缺失
          return { kind: 'json', value: { results: [{ index: 1, steps: [{ kind: 'assertVisible', locator: [{ strategy: 'role', value: 'main' }] }] }] }, provider: 'openai', vision: false };
        }
        return { kind: 'json', value: { steps: [{ kind: 'waitFor', locator: [{ strategy: 'role', value: 'main' }] }] }, provider: 'openai', vision: false };
      },
    };
    const steps = [
      { action: { kind: 'aiStep', instruction: 'a' } },
      { action: { kind: 'aiStep', instruction: 'b' } },
    ];
    const failed = await compileAiStepsInPlace(steps, client);
    expect(failed).toEqual([]);
    expect((steps[0]!.action as { compiled: unknown[] }).compiled).toHaveLength(1);
    expect((steps[1]!.action as { compiled: unknown[] }).compiled).toHaveLength(1);
  });

  it('marks steps with empty instruction and no name as failed', async () => {
    const client: LLMClient = {
      provider: 'openai',
      complete: async () => ({ kind: 'text', value: '', provider: 'openai', vision: false }),
    };
    const steps = [{ action: { kind: 'aiStep', instruction: '' } }];
    const failed = await compileAiStepsInPlace(steps, client);
    expect(failed).toEqual([0]);
    expect((steps[0]!.action as { compiled: unknown }).compiled).toBeNull();
  });
});

describe('compileAiStepsInPlace — heuristic shortcuts', () => {
  it('compiles "打开登录页" to navigate without calling LLM', async () => {
    let calls = 0;
    const client: LLMClient = {
      provider: 'openai',
      complete: async () => {
        calls++;
        return { kind: 'json', value: { steps: [] }, provider: 'openai', vision: false };
      },
    };
    const steps = [{ action: { kind: 'aiStep', instruction: '打开登录页' } }];
    const failed = await compileAiStepsInPlace(steps, client);
    expect(failed).toEqual([]);
    expect(calls).toBe(0);
    expect((steps[0]!.action as { compiled: unknown[] }).compiled).toEqual([
      { kind: 'navigate', url: 'http://localhost:5173/login' },
    ]);
  });

  it('uses group defaultUrl as base when provided via urlResolver', async () => {
    const client: LLMClient = {
      provider: 'openai',
      complete: async () => ({ kind: 'json', value: { steps: [] }, provider: 'openai', vision: false }),
    };
    const steps = [{ name: '步骤1', action: { kind: 'aiStep', instruction: '访问首页' } }];
    const failed = await compileAiStepsInPlace(
      steps,
      client,
      () => 'https://example.com',
    );
    expect(failed).toEqual([]);
    expect((steps[0]!.action as { compiled: unknown[] }).compiled).toEqual([
      { kind: 'navigate', url: 'https://example.com/' },
    ]);
  });

  it('does not heuristic-match when verb prefix is missing', async () => {
    let calls = 0;
    const client: LLMClient = {
      provider: 'openai',
      complete: async () => {
        calls++;
        return {
          kind: 'json',
          value: { steps: [{ kind: 'click', locator: [{ strategy: 'text', value: '登录' }] }] },
          provider: 'openai',
          vision: false,
        };
      },
    };
    // 没有"打开/访问"前缀 → 不启发式，落到 LLM
    const steps = [{ action: { kind: 'aiStep', instruction: '登录按钮' } }];
    const failed = await compileAiStepsInPlace(steps, client);
    expect(failed).toEqual([]);
    expect(calls).toBe(1);
  });

  it('compiles "断言看到工作台" to assertText without calling LLM', async () => {
    let calls = 0;
    const client: LLMClient = {
      provider: 'openai',
      complete: async () => {
        calls++;
        return { kind: 'json', value: { steps: [] }, provider: 'openai', vision: false };
      },
    };
    const steps = [{ action: { kind: 'aiStep', instruction: '断言看到工作台' } }];
    const failed = await compileAiStepsInPlace(steps, client);
    expect(failed).toEqual([]);
    expect(calls).toBe(0);
    expect((steps[0]!.action as { compiled: unknown[] }).compiled).toEqual([
      {
        kind: 'assertText',
        locator: [{ strategy: 'text', value: '工作台' }],
        target: 'specifiedElement',
        match: 'contains',
        equals: '工作台',
      },
    ]);
  });

  it('does not heuristic-match assertion with CSS placeholder', async () => {
    let calls = 0;
    const client: LLMClient = {
      provider: 'openai',
      complete: async () => {
        calls++;
        return {
          kind: 'json',
          value: { steps: [{ kind: 'assertVisible', locator: [{ strategy: 'css', value: '.main' }] }] },
          provider: 'openai',
          vision: false,
        };
      },
    };
    const steps = [{ action: { kind: 'aiStep', instruction: '断言 #main 可见' } }];
    await compileAiStepsInPlace(steps, client);
    expect(calls).toBe(1);
  });
});

describe('compileAiStepsBatch', () => {
  it('parses batch-shaped results and validates each entry', async () => {
    const client: LLMClient = {
      provider: 'openai',
      complete: async () => ({
        kind: 'json',
        value: {
          results: [
            { index: 1, steps: [{ kind: 'navigate', url: 'http://x' }] },
            { index: 2, steps: [{ kind: 'bogus' }, { kind: 'check', locator: [{ strategy: 'text', value: 'OK' }], checked: true }] },
            { index: 99, steps: [{ kind: 'navigate', url: 'http://out-of-range' }] },
          ],
        },
        provider: 'openai',
        vision: false,
      }),
    };
    const out = await compileAiStepsBatch([{ text: 'a' }, { text: 'b' }], client);
    expect(out.get(0)).toEqual([{ kind: 'navigate', url: 'http://x' }]);
    // 非法 kind 被丢弃，合法的保留
    expect(out.get(1)).toEqual([{ kind: 'check', locator: [{ strategy: 'text', value: 'OK' }], checked: true }]);
    // 越界 index 被忽略
    expect(out.has(2)).toBe(false);
  });

  it('treats single-shaped output as result for index 0', async () => {
    const client: LLMClient = {
      provider: 'openai',
      complete: async () => ({
        kind: 'json',
        value: { steps: [{ kind: 'waitFor', locator: [{ strategy: 'role', value: 'main' }] }] },
        provider: 'openai',
        vision: false,
      }),
    };
    const out = await compileAiStepsBatch([{ text: 'a' }, { text: 'b' }], client);
    expect(out.get(0)).toHaveLength(1);
    expect(out.has(1)).toBe(false);
  });

  it('returns empty map on non-json output', async () => {
    const client: LLMClient = {
      provider: 'openai',
      complete: async () => ({ kind: 'text', value: 'garbage', provider: 'openai', vision: false }),
    };
    const out = await compileAiStepsBatch([{ text: 'a' }], client);
    expect(out.size).toBe(0);
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
    const r: LLMResult = { kind: 'text', value: 'x', provider: 'openai', vision: false };
    expect(r.vision).toBe(false);
  });
});

describe('compileAiStep — fallback on empty instruction', () => {
  it('uses step.name when instruction is empty', async () => {
    let captured = '';
    const client: LLMClient = {
      provider: 'openai',
      complete: async (req) => {
        captured = req.userMessage;
        return {
          kind: 'json',
          value: { steps: [{ kind: 'waitFor', locator: [{ strategy: 'role', value: 'main' }] }] },
          provider: 'openai',
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
      provider: 'openai',
      complete: async () => ({ kind: 'text', value: '', provider: 'openai', vision: false }),
    };
    await expect(compileAiStep('', {}, client)).rejects.toThrow(/编译失败/);
  });
});

describe('compileAiStep — prompt includes trailing-assertText guidance', () => {
  it('user message or system prompt mentions 末尾 assertText or trailing assertion guidance', async () => {
    let captured = '';
    const client: LLMClient = {
      provider: 'openai',
      complete: async (req) => {
        captured = req.systemPrompt + '\n' + req.userMessage;
        return { kind: 'json', value: { steps: [{ kind: 'click', locator: [{ strategy: 'text', value: 'X' }] }] }, provider: 'openai', vision: false };
      },
    };
    await compileAiStep('click submit', {}, client);
    // Either "末尾 assertText" or "断言" + "assertText" hint should appear somewhere in the prompt context
    expect(captured).toMatch(/末尾.*assertText|assertText.*末尾|断言.*assertText/);
  });
});

describe('compileAiStepsInPlace — short-circuit pre-compiled', () => {
  it('does not call LLM for steps that already have compiled array', async () => {
    let calls = 0;
    const client: LLMClient = {
      provider: 'openai',
      complete: async () => {
        calls++;
        return { kind: 'json', value: { steps: [{ kind: 'waitFor', locator: [{ strategy: 'role', value: 'main' }] }] }, provider: 'openai', vision: false };
      },
    };
    const pre = [{ kind: 'click', locator: [{ strategy: 'text', value: 'A' }] }];
    const steps = [
      { action: { kind: 'aiStep', instruction: 'click A', compiled: pre } },
      { action: { kind: 'aiStep', instruction: 'click B', compiled: pre } },
    ];
    const failed = await compileAiStepsInPlace(steps, client);
    expect(failed).toEqual([]);
    expect(calls).toBe(0);
    expect((steps[0]!.action as { compiled: unknown }).compiled).toBe(pre);
    expect((steps[1]!.action as { compiled: unknown }).compiled).toBe(pre);
  });

  it('does not call LLM for steps with compiled=null (AI tried, gave up)', async () => {
    let calls = 0;
    const client: LLMClient = {
      provider: 'openai',
      complete: async () => {
        calls++;
        return { kind: 'json', value: { steps: [] }, provider: 'openai', vision: false };
      },
    };
    const steps = [
      { action: { kind: 'aiStep', instruction: 'any', compiled: null } },
    ];
    const failed = await compileAiStepsInPlace(steps, client);
    expect(failed).toEqual([0]);
    expect(calls).toBe(0);
    expect((steps[0]!.action as { compiled: unknown }).compiled).toBeNull();
  });

  it('mixed batch: pre-compiled skipped, un-compiled invoked', async () => {
    let calls = 0;
    const client: LLMClient = {
      provider: 'openai',
      complete: async () => {
        calls++;
        return { kind: 'json', value: { steps: [{ kind: 'waitFor', locator: [{ strategy: 'role', value: 'main' }] }] }, provider: 'openai', vision: false };
      },
    };
    const pre = [{ kind: 'click', locator: [{ strategy: 'text', value: 'A' }] }];
    const steps = [
      { action: { kind: 'aiStep', instruction: 'click A', compiled: pre } },
      { action: { kind: 'aiStep', instruction: 'click B' } },
    ];
    await compileAiStepsInPlace(steps, client);
    expect(calls).toBe(1);
    expect((steps[0]!.action as { compiled: unknown }).compiled).toBe(pre);
    expect((steps[1]!.action as { compiled: unknown }).compiled).toEqual([
      { kind: 'waitFor', locator: [{ strategy: 'role', value: 'main' }] },
    ]);
  });
});

describe('compileAiStep — vision path', () => {
  it('forwards image to provider when placeholders are present', async () => {
    let captured: { image?: unknown; userMessage?: string } = {};
    const client: LLMClient = {
      provider: 'openai',
      complete: async (req) => {
        captured = { image: req.image, userMessage: req.userMessage };
        return {
          kind: 'text',
          value: '识别出的文本',
          provider: 'openai',
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
