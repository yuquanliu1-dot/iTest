// apps/web/src/lib/stepSummary.test.ts
import { describe, it, expect } from 'vitest';
import { stepSummary } from './stepSummary';

const loc = (strategy = 'css', value = '#btn') => [{ strategy, value }];

describe('stepSummary', () => {
  it('navigate 显示 URL', () => {
    expect(stepSummary({ kind: 'navigate', url: 'https://example.com' })).toBe('打开 https://example.com');
  });

  it('click 优先用 intentLocator.contextText', () => {
    expect(stepSummary({ kind: 'click', locator: loc(), intentLocator: { semanticRole: 'button', contextText: '登录' } })).toBe('点击 登录');
  });

  it('click 无 intent 时用首个 locator', () => {
    expect(stepSummary({ kind: 'click', locator: loc('role', 'button') })).toBe('点击 role=button');
  });

  it('fill 固定值', () => {
    expect(stepSummary({ kind: 'fill', locator: loc(), value: 'alice' })).toBe('输入 alice');
  });

  it('fill sensitive 脱敏', () => {
    expect(stepSummary({ kind: 'fill', locator: loc(), value: '__sensitive__', sensitive: true })).toBe('输入 ***');
  });

  it('fill 生成器值显示模式名', () => {
    expect(stepSummary({ kind: 'fill', locator: loc(), value: { mode: 'randomString', length: 8 } })).toBe('输入 (随机字符串)');
  });

  it('select 显示值', () => {
    expect(stepSummary({ kind: 'select', locator: loc(), value: 'SH' })).toBe('选择 SH');
  });

  it('check / hover / waitFor / assertVisible', () => {
    expect(stepSummary({ kind: 'check', locator: loc(), checked: true })).toBe('勾选');
    expect(stepSummary({ kind: 'hover', locator: loc() })).toBe('悬停 css=#btn');
    expect(stepSummary({ kind: 'waitFor', locator: loc() })).toBe('等待元素 css=#btn');
    expect(stepSummary({ kind: 'assertVisible', locator: loc() })).toBe('断言可见 css=#btn');
  });

  it('assertText 按 match 生成', () => {
    expect(stepSummary({ kind: 'assertText', locator: [], target: 'page', match: 'contains', equals: '登录成功' })).toBe('断言文本 包含「登录成功」');
  });

  it('screenshot / upload / switchTab / assertJson', () => {
    expect(stepSummary({ kind: 'screenshot', name: 'shot1' })).toBe('截图 shot1');
    expect(stepSummary({ kind: 'upload', locator: loc(), fileId: 'u-1' })).toBe('上传文件');
    expect(stepSummary({ kind: 'switchTab', tabRef: 't1' })).toBe('切换标签页 t1');
    expect(stepSummary({ kind: 'assertJson', locator: loc(), equals: { a: 1 } })).toBe('断言 JSON');
  });

  it('extract 显示变量名', () => {
    expect(stepSummary({ kind: 'extract', locator: loc(), varName: 'orderId', mode: 'completeValue' })).toBe('提取 → {{orderId}}');
  });

  it('aiStep 显示指令前 40 字', () => {
    const long = 'x'.repeat(50);
    expect(stepSummary({ kind: 'aiStep', instruction: long, compiled: null })).toBe(`AI：${'x'.repeat(39)}…`);
  });

  it('未知类型回退 JSON 片段（超长截断）', () => {
    const action = { kind: 'weird', foo: 'x'.repeat(60) };
    expect(stepSummary(action)).toBe(JSON.stringify(action).slice(0, 39) + '…');
  });
});
