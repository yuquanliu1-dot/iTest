import { describe, it, expect } from 'vitest';
import { newAiUsage } from '../src/execute/aiUsage.js';

describe('newAiUsage accumulator', () => {
  it('零调用时 calls=0，不挂 usage', () => {
    const { stat } = newAiUsage();
    expect(stat).toEqual({ calls: 0, promptTokens: 0, completionTokens: 0, modelCallMs: 0, retries: 0 });
  });

  it('累加多次调用的 tokens/耗时/重试，model 取最后一次', () => {
    const acc = newAiUsage();
    acc.add({ usage: { promptTokens: 10, completionTokens: 5 }, durationMs: 1200, model: 'm-a' });
    acc.add({ usage: { promptTokens: 20, completionTokens: 8 }, durationMs: 800, retries: 1, model: 'm-b' });
    expect(acc.stat).toEqual({
      calls: 2,
      promptTokens: 30,
      completionTokens: 13,
      modelCallMs: 2000,
      retries: 1,
      model: 'm-b',
    });
  });

  it('字段缺省时（provider 未透出 usage）只计 calls', () => {
    const acc = newAiUsage();
    acc.add({});
    acc.add({ durationMs: 50 });
    expect(acc.stat.calls).toBe(2);
    expect(acc.stat.promptTokens).toBe(0);
    expect(acc.stat.modelCallMs).toBe(50);
  });
});
