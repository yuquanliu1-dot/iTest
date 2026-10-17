import { describe, it, expect } from 'vitest';
import { st, type StKey } from '../src/i18n.js';

/** 全量 zh 键的字节一致冻结：dict 里的 zh 文案必须与迁移前的中文字面量逐字相同。
 *  曾回归过一次（insert_step 空格漂移），用表驱动钉死全部键，防再犯。 */
const ZH_BYTE_IDENTITY: Array<[StKey, Record<string, string | number | boolean>, string]> = [
  ['case.updated', { title: '登录', keys: 'instruction' }, '更新「登录」(instruction)'],
  ['case.deleted', { title: 'T' }, '删除「T」'],
  ['case.moved', { title: 'T', target: 'g' }, '移动「T」到分组 g'],
  ['step.updated', { order: 1, changes: 'instruction' }, '更新步骤 #1（instruction）'],
  ['step.insertAfter', { order: 1 }, '在#1 后 插入新步骤'],
  ['step.insertEnd', {}, '在末尾 插入新步骤'],
  ['step.deleted', { order: 1 }, '删除步骤 #1'],
  ['step.reordered', { count: 2 }, '重排 2 个步骤'],
  ['plan.updated', { name: 'P' }, '更新计划「P」'],
  ['plan.casesAdded', { name: 'P', count: 3 }, '向计划「P」添加 3 个用例'],
  ['plan.casesRemoved', { name: 'P', count: 3 }, '从计划「P」移除 3 个用例'],
  ['plan.scheduleCreated', { name: 'P', cron: '0 9 * * *', tz: 'Asia/Shanghai', enabled: true }, '为计划「P」新建调度(cron=0 9 * * *, tz=Asia/Shanghai, enabled=true)'],
  ['plan.scheduleUpdated', { name: 'P' }, '更新计划「P」的调度'],
  ['plan.scheduleDeleted', { name: 'P', cron: '0 9 * * *' }, '删除计划「P」的调度(cron=0 9 * * *)'],
  ['env.updated', { name: 'E' }, '更新环境「E」'],
  ['env.credentialsSet', { name: 'E', type: 'mongo', label: 'L' }, '设置环境「E」的 mongo 对象「L」访问凭据(值不回显)'],
  ['env.deleted', { name: 'E', usage: '(无引用)' }, '删除环境「E」(无引用)'],
  ['env.usageReferenced', { caseCount: 3, planCount: 1 }, '(将使 3 个用例与 1 个计划的引用置空)'],
  ['env.usageNone', {}, '(无引用)'],
  ['scenario.updated', { title: 'S' }, '更新场景「S」'],
  ['scenario.deleted', { title: 'S' }, '删除场景「S」(关联用例将解绑)'],
  ['step.solidified', { order: 1, count: 2 }, '固化步骤 #1（aiTask → 2 个机械动作）'],
  ['planRun.summary', { passed: 1, failed: 0, skipped: 0 }, '1 通过 / 0 失败 / 0 跳过'],
  ['planRun.incognitoConflict', { caseIds: 'a,b' }, 'incognito 模式与登录准备互斥:a,b'],
  ['planRun.loginPrepareFailed', { reason: 'unknown' }, '登录准备失败:unknown'],
];

describe('st 服务端最小 t', () => {
  it.each(ZH_BYTE_IDENTITY)('zh %s 与迁移前文案字节一致', (key, vars, expected) => {
    expect(st('zh-CN', key, vars)).toBe(expected);
  });

  it('en-US 输出英文文案', () => {
    expect(st('en-US', 'case.deleted', { title: 'Login' })).toBe('Deleted "Login"');
    expect(st('en-US', 'step.insertAfter', { order: 1 })).toBe('Insert new step after #1');
  });

  it('en-US planRun summary 双语 + 数字插值', () => {
    expect(st('en-US', 'planRun.summary', { passed: 1, failed: 0, skipped: 0 })).toBe('1 passed / 0 failed / 0 skipped');
    expect(st('en-US', 'planRun.incognitoConflict', { caseIds: 'a,b' })).toBe('incognito mode conflicts with login prepare: a,b');
    expect(st('en-US', 'planRun.loginPrepareFailed', { reason: 'timeout' })).toBe('login prepare failed: timeout');
  });

  it('多变量插值(数字值)', () => {
    expect(st('en-US', 'env.usageReferenced', { caseCount: 3, planCount: 1 })).toBe('(will null out references of 3 case(s) and 1 plan(s))');
  });

  it('缺省/多余变量不崩溃', () => {
    expect(st('zh-CN', 'step.reordered', { count: 2 })).toBe('重排 2 个步骤');
    expect(st('zh-CN', 'step.reordered', { count: 2, extra: 'ignored' })).toBe('重排 2 个步骤');
  });

  it('计划调度确认卡 summary 双语 + 布尔插值', () => {
    expect(st('en-US', 'plan.scheduleCreated', { name: 'Smoke', cron: '0 9 * * *', tz: 'Asia/Shanghai', enabled: false })).toBe(
      'Created schedule for plan "Smoke" (cron=0 9 * * *, tz=Asia/Shanghai, enabled=false)',
    );
    expect(st('en-US', 'plan.scheduleDeleted', { name: 'Smoke', cron: '0 9 * * *' })).toBe('Deleted schedule of plan "Smoke" (cron=0 9 * * *)');
  });
});