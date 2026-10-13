import { describe, it, expect } from 'vitest';
import { buildOutcomeNote } from '../src/pi/space/tools/outcomeNote.js';

const CLICK = [{ kind: 'click', locator: [{ strategy: 'css', value: '#del' }] }];
const CREATE = [{ kind: 'click', locator: [{ strategy: 'css', value: '#newBtn' }] }];

describe('buildOutcomeNote · expectedOutcome 自洽体检', () => {
  it('观察型用例断言业务结果 + 步骤无操作动词 → 提示补造数步骤或调整预期（prod228 实测形态）', () => {
    // 回归动机:用例只做「进页面看列表」,expectedOutcome 却写「自动启动处置成功」,
    // 终态判定三轮全败后 AI 把预期改成「页面正常加载」蒙混通过。
    const note = buildOutcomeNote({
      expectedOutcome: '数据中心事件自动启动处置成功',
      stepActions: ['进入数据中心事件页面，查看工单处置状态'],
      stepCompileds: [CLICK],
    });
    expect(note).toBeTruthy();
    expect(note!).toContain('预期体检');
    expect(note!).toContain('蒙混通过');
    expect(note!).toContain('verify_case');
  });

  it('「处置」等观察语境高频词不算操作动词（否则观察型用例被误判为会造数）', () => {
    // "查看工单处置状态" 含「处置」——若纳入动词表,这条观察型用例会被误报。
    const note = buildOutcomeNote({
      expectedOutcome: '自动启动处置成功',
      stepActions: ['进入数据中心事件页面，查看工单处置状态'],
      stepCompileds: [CLICK],
    });
    expect(note).toBeTruthy();
  });

  it('步骤含操作动词（新建/提交…）→ 无提示', () => {
    expect(buildOutcomeNote({
      expectedOutcome: '新建事件成功出现在列表中',
      stepActions: ['新建一条事件', '查看列表'],
      stepCompileds: [CREATE, CLICK],
    })).toBeNull();
  });

  it('mutating httpRequest 造数同样算「造得出状态」（API 造数 → UI 验证）', () => {
    expect(buildOutcomeNote({
      expectedOutcome: '自动启动处置成功',
      stepActions: ['通过接口创建事件', '查看列表'],
      stepCompileds: [[{ kind: 'httpRequest', method: 'POST', url: 'http://x/api/event' }], CLICK],
    })).toBeNull();
    // GET 是读取，不算造数
    expect(buildOutcomeNote({
      expectedOutcome: '自动启动处置成功',
      stepActions: ['查询事件列表', '查看列表'],
      stepCompileds: [[{ kind: 'httpRequest', method: 'GET', url: 'http://x/api/event' }], CLICK],
    })).toBeTruthy();
  });

  it('expectedOutcome 只描述页面可达性（非业务结果）→ 无提示，不误伤打开页型用例', () => {
    expect(buildOutcomeNote({
      expectedOutcome: '页面正常加载，展示登录表单',
      stepActions: ['打开登录页'],
      stepCompileds: [CLICK],
    })).toBeNull();
  });

  it('expectedOutcome 为空/null/空白 → 无提示', () => {
    for (const v of [null, undefined, '', '   ']) {
      expect(buildOutcomeNote({ expectedOutcome: v, stepActions: ['点击'], stepCompileds: [CLICK] })).toBeNull();
    }
  });

  it('compiled 为 null（未编译步骤）+ 指令含操作动词 → 仍无提示（只信自然语言指令）', () => {
    expect(buildOutcomeNote({
      expectedOutcome: '保存后配置生效',
      stepActions: ['保存配置', null],
      stepCompileds: [null, null],
    })).toBeNull();
  });
});