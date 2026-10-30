import { describe, it, expect } from 'vitest';
import { buildExportTree, buildExportPayload, describeAction, type ExportCaseRow } from './caseExport.service.js';

function mkCase(over: Partial<ExportCaseRow> = {}): ExportCaseRow {
  return {
    id: over.id ?? crypto.randomUUID(),
    title: over.title ?? '验证登录成功',
    // 不用 ??：需区分「未传」与「显式 null」，否则空字段用例无法构造
    description: over.description !== undefined ? over.description : '1.系统运行正常',
    expectedOutcome: over.expectedOutcome !== undefined ? over.expectedOutcome : '1.跳转首页',
    groupId: over.groupId ?? 'g1',
    groupName: over.groupName ?? '登录模块',
    versionId: over.versionId ?? 'v1',
    versionName: over.versionName ?? 'V2.3',
    createdAt: over.createdAt ?? new Date('2026-01-01T00:00:00Z'),
    steps: over.steps ?? [
      { order: 1, instruction: '打开登录页', compiled: null, assertion: null },
      { order: 2, instruction: '', compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '.btn-login' }] }], assertion: null },
      { order: 3, instruction: '', compiled: null, assertion: { kind: 'assertText', match: 'equals', equals: '登录成功' } },
    ],
  };
}

describe('buildExportTree', () => {
  it('root=版本名，一层分组、二层用例、三层三要素', () => {
    const tree = buildExportTree([mkCase()], 'V2.3');
    expect(tree.title).toBe('V2.3');
    expect(tree.children).toHaveLength(1);
    const group = tree.children![0]!;
    expect(group.title).toBe('登录模块');
    expect(group.children).toHaveLength(1);
    const c = group.children![0]!;
    expect(c.title).toBe('验证登录成功');
    expect(c.children!.map((n) => n.title)).toEqual(['预置条件', '测试步骤', '预期结果']);
    const steps = c.children![1]!.children!;
    expect(steps[0]!.title).toBe('1. 打开登录页');
    // instruction 空 → DSL 摘要
    expect(steps[1]!.title).toBe('2. 点击 css=.btn-login');
    // 无 instruction 无 compiled → assertion 兜底渲染
    expect(steps[2]!.title).toBe('3. 验证文本等于「登录成功」');
  });

  it('同分组多用例合并到一个分组节点；分组按名称排序；用例按 createdAt 排序', () => {
    const a = mkCase({ title: '用例A', groupName: 'B组', createdAt: new Date('2026-01-02T00:00:00Z') });
    const b = mkCase({ title: '用例B', groupName: 'B组', createdAt: new Date('2026-01-01T00:00:00Z') });
    const c = mkCase({ title: '用例C', groupName: 'A组' });
    const tree = buildExportTree([a, b, c], 'V2.3');
    expect(tree.children!.map((g) => g.title)).toEqual(['A组', 'B组']);
    expect(tree.children![1]!.children!.map((x) => x.title)).toEqual(['用例B', '用例A']);
  });

  it('跨版本时在 root 与分组之间插版本层', () => {
    const tree = buildExportTree(
      [mkCase({ versionName: 'V2.3' }), mkCase({ versionName: 'V2.4' })],
      '导出',
    );
    expect(tree.children!.map((n) => n.title)).toEqual(['V2.3', 'V2.4']);
    expect(tree.children![0]!.children![0]!.title).toBe('登录模块');
  });

  it('空字段省略：无 description/expectedOutcome/steps 的用例只出标题节点', () => {
    const tree = buildExportTree(
      [mkCase({ description: null, expectedOutcome: null, steps: [] })],
      'V2.3',
    );
    const c = tree.children![0]!.children![0]!;
    expect(c.children).toBeUndefined();
  });

  it('expectedOutcome 优先，多行拆编号；为空时逐条行级断言兜底', () => {
    const withOutcome = buildExportTree([mkCase({ expectedOutcome: '第一行\n第二行' })], 'V').children![0]!.children![0]!;
    expect(withOutcome.children![2]!.children!.map((n) => n.title)).toEqual(['1. 第一行', '2. 第二行']);
    const noOutcome = buildExportTree(
      [mkCase({ expectedOutcome: null, steps: [
        { order: 1, instruction: 'a', compiled: null, assertion: { kind: 'assertText', match: 'contains', equals: '成功' } },
      ] })],
      'V',
    ).children![0]!.children![0]!;
    expect(noOutcome.children![2]!.children![0]!.title).toBe('1. 验证文本包含「成功」');
  });

  it('多动作 compiled 链用 → 串联；敏感值掩码', () => {
    const tree = buildExportTree(
      [mkCase({ steps: [
        { order: 1, instruction: '', compiled: [
          { kind: 'fill', locator: [{ strategy: 'css', value: '#pw' }], value: 'secret', sensitive: true },
          { kind: 'click', locator: [{ strategy: 'css', value: '.submit' }] },
        ], assertion: null },
      ] })],
      'V',
    );
    expect(tree.children![0]!.children![0]!.children![1]!.children![0]!.title)
      .toBe('1. 输入 *** → 点击 css=.submit');
  });
});

describe('describeAction 补充 kind', () => {
  it('httpRequest 带 method/url/saveAs', () => {
    expect(describeAction({ kind: 'httpRequest', method: 'POST', url: 'http://x/api', saveAs: { varName: 'token' } }))
      .toBe('请求 POST http://x/api → {{token}}');
    expect(describeAction({ kind: 'httpRequest', url: 'http://x/api' })).toBe('请求 GET http://x/api');
  });
  it('sql 压单行截断', () => {
    expect(describeAction({ kind: 'sql', sql: 'select\n  *\n  from t' })).toBe('执行 SQL：select * from t');
  });
});

describe('buildExportPayload', () => {
  it('baseName 缺省用第一个用例的版本名；rootTitle 优先；tree 与 count 就位且 JSON 可序列化', () => {
    const p = buildExportPayload([mkCase()]);
    expect(p.baseName).toBe('V2.3');
    expect(p.count).toBe(1);
    expect(p.tree.title).toBe('V2.3');
    expect(() => JSON.stringify(p)).not.toThrow();
    const p2 = buildExportPayload([mkCase()], ' 评审材料 ');
    expect(p2.baseName).toBe('评审材料');
    expect(p2.tree.title).toBe('评审材料');
  });
});
