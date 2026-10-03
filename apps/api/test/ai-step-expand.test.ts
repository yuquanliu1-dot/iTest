import { describe, it, expect } from 'vitest';
import { StepAction } from '@itest/shared';
import { expandCompiledAiStepsInPlace } from '../src/lib/ai-step-expand.js';

describe('expandCompiledAiStepsInPlace', () => {
  it('已编译 aiStep 展开为多条具体 DSL（navigate/click/fill），UI 可直接编辑', () => {
    const prepared = [{
      stepRows: [
        {
          source: 'agent' as const,
          name: '访问登录页',
          action: {
            kind: 'aiStep',
            instruction: '访问登录页',
            compiled: [
              { kind: 'navigate', url: 'http://192.168.30.228:8088/static/login.html' },
              { kind: 'fill', locator: [{ strategy: 'css', value: "input[name='username']" }], value: 'admin' },
              { kind: 'click', locator: [{ strategy: 'css', value: "button[type='submit']" }] },
            ],
          },
          assertion: { kind: 'assertText', text: '登录成功' } as unknown as object,
          sensitive: false,
        },
      ],
    }];
    expandCompiledAiStepsInPlace(prepared);
    const rows = prepared[0]!.stepRows;
    expect(rows).toHaveLength(3);
    expect(rows[0]!.name).toBe('navigate');
    expect(rows[0]!.action).toMatchObject({ kind: 'navigate', url: 'http://192.168.30.228:8088/static/login.html' });
    expect((rows[0]!.action as { kind: string }).kind).toBe('navigate');
    expect(rows[1]!.name).toBe('fill');
    expect(rows[1]!.action).toMatchObject({ kind: 'fill', value: 'admin' });
    expect(rows[2]!.name).toBe('click');
    // assertion 只挂在首条（避免复制到每条子步骤）
    expect(rows[0]!.assertion).toBeTruthy();
    expect(rows[1]!.assertion).toBeNull();
    expect(rows[2]!.assertion).toBeNull();
    // aiStep.name 保留在首条 componentKind 里方便反查
    expect((rows[0] as Record<string, unknown>).componentKind).toBe('aiStep/访问登录页');
  });

  it('放弃（compiled:null）的 aiStep 原样保留，回放仍按 aiStep 兜底', () => {
    const row = {
      source: 'agent' as const,
      name: '模糊指令',
      action: { kind: 'aiStep', instruction: '模糊指令', compiled: null } as object,
      assertion: null,
      sensitive: false,
    };
    const prepared = [{ stepRows: [row] }];
    expandCompiledAiStepsInPlace(prepared);
    expect(prepared[0]!.stepRows).toEqual([row]);
  });

  it('未尝试（无 compiled 字段）的 aiStep 原样保留', () => {
    const row = {
      source: 'agent' as const,
      name: '未知指令',
      action: { kind: 'aiStep', instruction: '未知指令' } as object,
      assertion: null,
      sensitive: false,
    };
    const prepared = [{ stepRows: [row] }];
    expandCompiledAiStepsInPlace(prepared);
    expect(prepared[0]!.stepRows).toEqual([row]);
  });

  it('混合用例：第 1 条已编译展开、第 2 条放弃保留', () => {
    const prepared = [{
      stepRows: [
        {
          source: 'agent' as const,
          name: '访问登录页',
          action: {
            kind: 'aiStep',
            instruction: '访问登录页',
            compiled: [{ kind: 'navigate', url: 'http://example.com/login' }],
          },
          assertion: null,
          sensitive: false,
        },
        {
          source: 'agent' as const,
          name: '模糊指令',
          action: { kind: 'aiStep', instruction: '模糊指令', compiled: null } as object,
          assertion: null,
          sensitive: false,
        },
      ],
    }];
    expandCompiledAiStepsInPlace(prepared);
    const rows = prepared[0]!.stepRows;
    expect(rows).toHaveLength(2);
    expect((rows[0]!.action as { kind: string }).kind).toBe('navigate');
    expect((rows[1]!.action as { kind: string }).kind).toBe('aiStep');
    expect(((rows[1]!.action) as { compiled: unknown }).compiled).toBeNull();
  });

  it('子步骤非法 → 整条 aiStep 还原保留（防御性）', () => {
    const prepared = [{
      stepRows: [
        {
          source: 'agent' as const,
          name: '脏数据',
          action: {
            kind: 'aiStep',
            instruction: '脏数据',
            compiled: [
              { kind: 'navigate', url: 'http://example.com' },
              { kind: 'click', locator: 'this-is-not-an-array' }, // 非法 locator 形态
            ],
          },
          assertion: null,
          sensitive: false,
        },
      ],
    }];
    expandCompiledAiStepsInPlace(prepared);
    expect(prepared[0]!.stepRows).toHaveLength(1);
    expect((prepared[0]!.stepRows[0]!.action as { kind: string }).kind).toBe('aiStep');
  });

  it('展开后每条子步骤仍能被 StepAction.safeParse 接收（可回放）', () => {
    const compiled = [
      { kind: 'navigate', url: 'http://example.com/login' },
      { kind: 'fill', locator: [{ strategy: 'css', value: "input[name='username']" }], value: 'admin' },
      { kind: 'fill', locator: [{ strategy: 'css', value: "input[name='password']" }], value: 'p' },
      { kind: 'click', locator: [{ strategy: 'css', value: "button[type='submit']" }] },
      { kind: 'assertVisible', locator: [{ strategy: 'css', value: '.dashboard' }] },
    ];
    const prepared = [{
      stepRows: [{
        source: 'agent' as const,
        name: '登录成功',
        action: { kind: 'aiStep', instruction: '登录成功', compiled },
        assertion: null,
        sensitive: false,
      }],
    }];
    expandCompiledAiStepsInPlace(prepared);
    for (const row of prepared[0]!.stepRows) {
      const r = StepAction.safeParse(row.action);
      expect(r.success).toBe(true);
    }
  });
});
