import { describe, it, expect } from 'vitest';
import { st } from '../src/i18n.js';

describe('st 服务端最小 t', () => {
  it('zh-CN 输出与既有中文文案字节一致', () => {
    expect(st('zh-CN', 'case.updated', { title: '登录', keys: 'instruction' })).toBe('更新「登录」(instruction)');
    expect(st('zh-CN', 'step.insertAfter', { order: 1 })).toBe('在#1 后 插入新步骤');
    expect(st('zh-CN', 'step.insertEnd')).toBe('在末尾 插入新步骤');
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

  it('计划调度确认卡 summary 双语 + 布尔插值', () => {
    expect(
      st('zh-CN', 'plan.scheduleCreated', { name: '冒烟', cron: '0 9 * * *', tz: 'Asia/Shanghai', enabled: true }),
    ).toBe('为计划「冒烟」新建调度(cron=0 9 * * *, tz=Asia/Shanghai, enabled=true)');
    expect(
      st('en-US', 'plan.scheduleCreated', { name: 'Smoke', cron: '0 9 * * *', tz: 'Asia/Shanghai', enabled: false }),
    ).toBe('Created schedule for plan "Smoke" (cron=0 9 * * *, tz=Asia/Shanghai, enabled=false)');
    expect(st('zh-CN', 'plan.scheduleDeleted', { name: '冒烟', cron: '0 9 * * *' })).toBe('删除计划「冒烟」的调度(cron=0 9 * * *)');
  });
});