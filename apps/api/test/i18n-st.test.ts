import { describe, it, expect } from 'vitest';
import { st } from '../src/i18n.js';

describe('st 服务端最小 t', () => {
  it('zh-CN 输出与既有中文文案字节一致', () => {
    expect(st('zh-CN', 'case.updated', { title: '登录', keys: 'instruction' })).toBe('更新「登录」(instruction)');
  });

  it('en-US 输出英文文案', () => {
    expect(st('en-US', 'case.deleted', { title: 'Login' })).toBe('Deleted "Login"');
  });

  it('多变量插值(数字值)', () => {
    expect(st('en-US', 'env.usageReferenced', { caseCount: 3, planCount: 1 })).toBe('(will null out references of 3 case(s) and 1 plan(s))');
  });

  it('缺省/多余变量不崩溃:已用变量全部传值时输出确定', () => {
    expect(st('zh-CN', 'step.reordered', { count: 2 })).toBe('重排 2 个步骤');
    expect(st('zh-CN', 'step.reordered', { count: 2, extra: 'ignored' })).toBe('重排 2 个步骤');
  });
});