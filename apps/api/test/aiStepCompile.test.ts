import { describe, it, expect } from 'vitest';
import { compileAiStep, compileAiStepsInPlace } from '../src/agent/aiStepCompile.js';
import type { LLMClient } from '../src/agent/llm-client.js';

const fakeClient = (outputs: { steps?: unknown }[]): LLMClient => ({
  provider: 'mock',
  complete: async () => {
    const v = outputs.shift();
    return v ? { kind: 'json', value: v as Record<string, unknown> } : { kind: 'text', value: '' };
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
        if (calls === 1) return { kind: 'json', value: { steps: [{ kind: 'waitFor', locator: [{ strategy: 'role', value: 'main' }] }] } };
        return { kind: 'text', value: 'garbage' };
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
