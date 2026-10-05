import { describe, it, expect } from 'vitest';
import { migrateAction, sanitizeAssertion } from '../src/lib/step-migration.js';

describe('migrateAction — assertText', () => {
  it('adds target=specifiedElement + match=equals to legacy assertText', () => {
    const legacy = { kind: 'assertText', locator: [{ strategy: 'css', value: '.msg' }], equals: 'ok' };
    const out = migrateAction(legacy);
    expect(out).toEqual({
      kind: 'assertText',
      locator: [{ strategy: 'css', value: '.msg' }],
      intentLocator: undefined,
      target: 'specifiedElement',
      match: 'equals',
      equals: 'ok',
    });
  });

  it('does not overwrite explicit target/match', () => {
    const current = {
      kind: 'assertText',
      locator: [{ strategy: 'css', value: '.msg' }],
      target: 'page',
      match: 'regex',
      equals: '^ok',
    };
    const out = migrateAction(current);
    expect(out.target).toBe('page');
    expect(out.match).toBe('regex');
  });
});

describe('migrateAction — locator-bearing kinds', () => {
  it('adds intentLocator=undefined to legacy click', () => {
    const legacy = { kind: 'click', locator: [{ strategy: 'css', value: '#btn' }] };
    const out = migrateAction(legacy) as { intentLocator?: unknown };
    expect(out.intentLocator).toBeUndefined();
  });

  it('does not touch known kinds lacking intentLocator (fill/hover/waitFor/check/select/extract)', () => {
    const kinds = ['fill', 'hover', 'waitFor', 'check', 'select', 'extract'];
    for (const k of kinds) {
      const legacy = { kind: k, locator: [{ strategy: 'css', value: '#x' }], ...(k === 'fill' || k === 'select' ? { value: 'x' } : {}) };
      const out = migrateAction(legacy) as { intentLocator?: unknown };
      expect(out.intentLocator).toBeUndefined();
    }
  });
});

describe('migrateAction — idempotency', () => {
  it('is a no-op on already migrated actions', () => {
    const migrated = {
      kind: 'assertText',
      locator: [{ strategy: 'css', value: '.msg' }],
      intentLocator: { semanticRole: 'msg' },
      target: 'specifiedElement' as const,
      match: 'contains' as const,
      equals: 'ok',
    };
    expect(migrateAction(migrated)).toEqual(migrated);
  });
});

describe('migrateAction — defensive', () => {
  it('returns unknown kinds unchanged', () => {
    const alien = { kind: 'bogus', locator: [{ strategy: 'css', value: '#x' }] };
    expect(migrateAction(alien)).toEqual(alien);
  });
});

describe('migrateAction — aiStep assertion field', () => {
  it('adds assertion=undefined to legacy aiStep without assertion', () => {
    const legacy = { kind: 'aiStep', instruction: '提交订单', compiled: null };
    const out = migrateAction(legacy) as { assertion?: unknown };
    expect(out.assertion).toBeUndefined();
  });

  it('does not overwrite existing assertion', () => {
    const cur = { kind: 'aiStep', instruction: 'x', compiled: null, assertion: '页面显示成功' };
    const out = migrateAction(cur) as { assertion?: string };
    expect(out.assertion).toBe('页面显示成功');
  });

  it('does not touch non-aiStep kinds', () => {
    const click = { kind: 'click', locator: [{ strategy: 'css', value: '#btn' }] };
    const out = migrateAction(click) as { assertion?: unknown };
    expect('assertion' in out).toBe(false);
  });
});

describe('migrateAction — extract mode lazy migration', () => {
  it('adds mode=completeValue to legacy extract', () => {
    const legacy = { kind: 'extract', locator: [{ strategy: 'css', value: '#x' }], varName: 'orderNo' };
    const out = migrateAction(legacy) as { mode?: string; intentLocator?: unknown; varName?: string };
    expect(out.mode).toBe('completeValue');
    expect(out.intentLocator).toBeUndefined();
    expect(out.varName).toBe('orderNo');
  });

  it('preserves explicit mode on extract', () => {
    const cur = {
      kind: 'extract',
      locator: [{ strategy: 'css', value: '#x' }],
      varName: 'orderNo',
      mode: 'regex' as const,
      pattern: '\\d+',
    };
    const out = migrateAction(cur) as { mode?: string; pattern?: string };
    expect(out.mode).toBe('regex');
    expect(out.pattern).toBe('\\d+');
  });
});

describe('sanitizeAssertion — content-level filter', () => {
  it('空字符串 → null', () => {
    expect(sanitizeAssertion('')).toBeNull();
  });

  it('非字符串 → null', () => {
    expect(sanitizeAssertion(undefined)).toBeNull();
    expect(sanitizeAssertion(null)).toBeNull();
    expect(sanitizeAssertion(123)).toBeNull();
    expect(sanitizeAssertion({})).toBeNull();
  });

  it('纯空白 → null', () => {
    expect(sanitizeAssertion('   ')).toBeNull();
  });

  it('短真实 UI 文案保留(≤4字)', () => {
    expect(sanitizeAssertion('登录')).toBe('登录');
    expect(sanitizeAssertion('成功')).toBe('成功');
  });

  it('中等长度真实 UI 文案保留', () => {
    expect(sanitizeAssertion('登录成功')).toBe('登录成功');
    expect(sanitizeAssertion('工作台')).toBe('工作台');
    expect(sanitizeAssertion('锁定中,请30秒后再试')).toBe('锁定中,请30秒后再试');
  });

  it('描述性短语被过滤:命中"展示"', () => {
    expect(sanitizeAssertion('登录表单正常展示')).toBeNull();
    expect(sanitizeAssertion('表单展示成功')).toBeNull();
  });

  it('描述性短语被过滤:命中"回显"', () => {
    expect(sanitizeAssertion('账号输入回显正常')).toBeNull();
    expect(sanitizeAssertion('密码回显完成')).toBeNull();
  });

  it('描述性短语被过滤:命中"触发/已发出"', () => {
    expect(sanitizeAssertion('账号已触发锁定且未到期')).toBeNull();
    expect(sanitizeAssertion('登录请求已发出')).toBeNull();
  });

  it('描述性短语被过滤:其它描述性动词', () => {
    expect(sanitizeAssertion('应该显示错误提示')).toBeNull();
    expect(sanitizeAssertion('预期登录成功')).toBeNull();
    expect(sanitizeAssertion('验证码填写成功(人工识别)')).toBeNull();
  });

  it('长度 4 边界:纯真实 UI 文案保留', () => {
    // 长度恰好 = 4 → 走短断言放行分支,不查描述词表。
    // "填写成功" 实际是描述性,但与"登录按钮"这类 4 字真实文案无法区分,
    // 风险收益上放行;5+ 字才严查描述词。
    expect(sanitizeAssertion('填写成功')).toBe('填写成功');
  });

  it('首尾空白被 trim 但保留', () => {
    expect(sanitizeAssertion('  工作台  ')).toBe('工作台');
  });
});
