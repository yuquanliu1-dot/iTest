import { describe, it, expect } from 'vitest';
import { buildOutcomeNote } from '../src/pi/space/tools/outcomeNote.js';

const CLICK = [{ kind: 'click', locator: [{ strategy: 'css', value: '#del' }] }];
const CREATE = [{ kind: 'click', locator: [{ strategy: 'css', value: '#newBtn' }] }];

describe('buildOutcomeNote · expectedOutcome 自洽体检', () => {
  it('观察型用例断言业务结果 + 步骤无操作动词 → 提示补造数步骤或调整预期（prod228 实测形态）', () => {
    // Regression motivation: the case only does "open the page and look at the list", yet expectedOutcome claims "disposal auto-started successfully";
    // after the terminal-state check failed three rounds, the AI changed the expectation to "page loads normally" to sneak through.
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
    // "查看工单处置状态" contains "处置" — if it joined the verb list, this observation-style case would be a false positive.
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
    // GET is a read, not state fabrication
    expect(buildOutcomeNote({
      expectedOutcome: '自动启动处置成功',
      stepActions: ['查询事件列表', '查看列表'],
      stepCompileds: [[{ kind: 'httpRequest', method: 'GET', url: 'http://x/api/event' }], CLICK],
    })).toBeTruthy();
  });

  it('sendSyslog/sql/observeLog 协议步产生或取证 SUT 状态 → 无提示（dump1 syslog 用例误报回归）', () => {
    // Regression motivation: observed in dump1 — the "send syslog → check logs to confirm the linkage" case was a false positive under the old rule
    // ("no step produces this outcome"), and the AI was misled into adding pointless state-fabrication steps.
    for (const kind of ['sendSyslog', 'sql', 'observeLog']) {
      expect(buildOutcomeNote({
        expectedOutcome: '自动启动处置成功',
        stepActions: ['发送日志并观察联动结果'],
        stepCompileds: [[{ kind }]],
      })).toBeNull();
    }
    // Kinds that don't produce SUT state (navigate) → still flagged
    expect(buildOutcomeNote({
      expectedOutcome: '自动启动处置成功',
      stepActions: ['打开处置页面'],
      stepCompileds: [[{ kind: 'navigate', url: 'https://x/y' }]],
    })).toBeTruthy();
  });

  it('纯观察型预期（观察词无强结果词）→ 豁免；观察词+强结果词 → 仍提示', () => {
    // "页面正常加载成功" contains a RESULT word (成功) but is observational in nature → not checked
    expect(buildOutcomeNote({
      expectedOutcome: '页面正常加载成功',
      stepActions: ['打开登录页'],
      stepCompileds: [CLICK],
    })).toBeNull();
    // "列表可见" + "自动启动处置" claims both sides → not exempt (prevents watered-down wording sneaking through)
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