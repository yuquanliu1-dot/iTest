import { describe, it, expect } from 'vitest';
import { resolveDotPath, HttpRequestSaveAsFailed } from '../src/execute/httpRequest.js';
import { buildVariableReport } from '../src/lib/variable-report.js';
import type { StepAction } from '@itest/shared';

describe('resolveDotPath', () => {
  const data = { data: { items: [{ id: 'a1' }, { id: 'a2' }], total: 2 }, meta: null };

  it('解析嵌套对象与数组下标', () => {
    expect(resolveDotPath(data, 'data.items[0].id')).toBe('a1');
    expect(resolveDotPath(data, 'data.items[1].id')).toBe('a2');
    expect(resolveDotPath(data, 'data.total')).toBe(2);
  });

  it('路径缺失/类型不符抛 HttpRequestSaveAsFailed', () => {
    expect(() => resolveDotPath(data, 'data.missing.deep')).toThrow(HttpRequestSaveAsFailed);
    expect(() => resolveDotPath(data, 'data.items[5].id')).toThrow(HttpRequestSaveAsFailed);
    expect(() => resolveDotPath(data, 'data.items.id')).toThrow(HttpRequestSaveAsFailed);
    expect(() => resolveDotPath(data, '')).toThrow(HttpRequestSaveAsFailed);
  });
});

describe('buildVariableReport × httpRequest', () => {
  it('saveAs 定义变量、url/body/断言引用变量；前向引用被检出', () => {
    const steps: StepAction[] = [
      { kind: 'httpRequest', method: 'GET', url: '{{apiBase}}/users', headers: [{ key: 'Authorization', value: 'Bearer {{token}}' }], timeoutMs: 10000, saveAs: { varName: 'userId', from: 'body', path: 'data.id' } },
      { kind: 'navigate', url: 'https://x.test/detail?u={{userId}}' },
      { kind: 'fill', locator: [{ strategy: 'css', value: '#q' }], value: '{{userId}}' },
      { kind: 'httpRequest', method: 'POST', url: 'https://x.test/o', headers: [], body: '{"uid":"{{userId}}","ref":"{{later}}"}', timeoutMs: 10000 },
      { kind: 'extract', locator: [{ strategy: 'css', value: '#q' }], varName: 'later', mode: 'completeValue' },
    ];
    const report = buildVariableReport(steps, ['apiBase', 'token']);
    // later 前向引用；userId 正常消费
    expect(report.forwardRefs.map((f) => f.name)).toEqual(['later']);
    expect(report.undefined).toEqual([]);
    expect(report.duplicates).toEqual([]);
  });

  it('未定义变量（无初始变量）报 undefined', () => {
    const steps: StepAction[] = [
      { kind: 'httpRequest', method: 'GET', url: '{{apiBase}}/x', headers: [], timeoutMs: 10000 },
    ];
    const report = buildVariableReport(steps);
    expect(report.undefined.map((u) => u.name)).toEqual(['apiBase']);
  });
});
