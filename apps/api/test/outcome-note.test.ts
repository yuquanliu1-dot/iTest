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

  it('sendSyslog/sql/observeLog 协议步产生或取证 SUT 状态 → 无提示（dump1 syslog 用例误报回归）', () => {
    // 回归动机:dump1 实测——「发送 syslog → 查日志确认联动」用例被旧口径误报
    // 「步骤里没有会产生该结果的操作」,AI 被带偏去补无谓的造数步骤。
    for (const kind of ['sendSyslog', 'sql', 'observeLog']) {
      expect(buildOutcomeNote({
        expectedOutcome: '自动启动处置成功',
        stepActions: ['发送日志并观察联动结果'],
        stepCompileds: [[{ kind }]],
      })).toBeNull();
    }
    // queryDb 查的是平台自己的库,与 SUT 业务状态无关 → 仍提示
    expect(buildOutcomeNote({
      expectedOutcome: '自动启动处置成功',
      stepActions: ['查询平台数据'],
      stepCompileds: [[{ kind: 'queryDb' }]],
    })).toBeTruthy();
  });

  it('纯观察型预期（观察词无强结果词）→ 豁免；观察词+强结果词 → 仍提示', () => {
    // 「页面正常加载成功」含 RESULT 词（成功）但本质是观察型 → 不体检
    expect(buildOutcomeNote({
      expectedOutcome: '页面正常加载成功',
      stepActions: ['打开登录页'],
      stepCompileds: [CLICK],
    })).toBeNull();
    // 「列表可见」+「自动启动处置」两头占 → 不豁免（防弱化措辞蒙混）
    expect(buildOutcomeNote({
      expectedOutcome: '处置列表可见且自动启动处置成功',
      stepActions: ['查看列表'],
      stepCompileds: [CLICK],
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