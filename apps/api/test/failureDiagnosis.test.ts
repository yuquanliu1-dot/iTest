import { describe, it, expect } from 'vitest';
import type { LLMClient, LLMResult } from '../src/agent/llm-client.js';
import { diagnoseFailure } from '../src/pi/space/tools/failureDiagnosis.js';
import type { PageElementSnapshot } from '../src/pi/inspectPage.js';

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

const elements: PageElementSnapshot = {
  url: 'http://sut/rule/list',
  title: '规则列表',
  bodyLen: 500,
  elements: ['- input[name=keyword] 选择器: input[name=keyword]'],
  truncated: false,
};

const baseArg = {
  step: { id: 's1', order: 1, instruction: '点击确定', compiled: [], assertion: null, sensitive: false, delayMs: null },
  assertion: null,
  probes: [{ strategy: 'css', value: '#save-btn', hitCount: 0 }],
  overlays: [{ tag: 'div', selector: '.el-dialog', text: '确认删除？' }],
  elements,
};

describe('diagnoseFailure', () => {
  it('LLM 判 position-fracture → 原样返回（位置/流程断裂，修流程非 locator）', async () => {
    const { llm } = makeMockLlm([{ diagnosis: 'position-fracture', note: '规则编辑向导未挂载到该步，核对导航步骤顺序' }]);
    const r = await diagnoseFailure({ ...baseArg, client: llm });
    expect(r).not.toBeNull();
    expect(r!.diagnosis).toBe('position-fracture');
    expect(r!.note).toContain('向导');
  });

  it('LLM 判 conditional-overlay → 原样返回（条件性浮层，补 aiTask 兜底）', async () => {
    const { llm } = makeMockLlm([{ diagnosis: 'conditional-overlay', note: '页面有可见弹窗，补 aiTask 条件兜底步骤' }]);
    const r = await diagnoseFailure({ ...baseArg, client: llm });
    expect(r!.diagnosis).toBe('conditional-overlay');
  });

  it('LLM 判 locator-fix → 原样返回（用真实选择器修 locator）', async () => {
    const { llm } = makeMockLlm([{ diagnosis: 'locator-fix', note: '用 #save-btn 替换原 locator' }]);
    const r = await diagnoseFailure({ ...baseArg, client: llm });
    expect(r!.diagnosis).toBe('locator-fix');
  });

  it('诊断值不在枚举内 → 归为 other（不抛错）', async () => {
    const { llm } = makeMockLlm([{ diagnosis: 'mystery', note: '说不准' }]);
    const r = await diagnoseFailure({ ...baseArg, client: llm });
    expect(r!.diagnosis).toBe('other');
    expect(r!.note).toBe('说不准');
  });

  it('形态无关证据全部进 user message（命中数/浮层/元素清单/probes）', async () => {
    const { llm, requests } = makeMockLlm([{ diagnosis: 'locator-fix', note: '' }]);
    await diagnoseFailure({ ...baseArg, client: llm });
    expect(requests[0]).toContain('css=#save-btn');
    expect(requests[0]).toContain('命中 0 个元素');
    expect(requests[0]).toContain('确认删除？');
    expect(requests[0]).toContain('input[name=keyword]');
  });

  it('extraHint（空数据信号）并入 user message', async () => {
    const { llm, requests } = makeMockLlm([{ diagnosis: 'other', note: '' }]);
    await diagnoseFailure({ ...baseArg, client: llm, extraHint: '失败页检出空数据信号「共 0 条」' });
    expect(requests[0]).toContain('空数据信号');
  });

  it('LLM 抛错 → 返回 null（调用方回退一般文案，不静默丢信息）', async () => {
    const { llm } = makeMockLlm([]);
    const r = await diagnoseFailure({ ...baseArg, client: llm });
    expect(r).toBeNull();
  });

  it('LLM 返回非 JSON / 缺 diagnosis 或 note → 返回 null', async () => {
    const { llm: l1 } = makeMockLlm(['这不是 JSON']);
    expect(await diagnoseFailure({ ...baseArg, client: l1 })).toBeNull();
    const { llm: l2 } = makeMockLlm([{ diagnosis: 'locator-fix' }]);
    expect(await diagnoseFailure({ ...baseArg, client: l2 })).toBeNull();
  });
});