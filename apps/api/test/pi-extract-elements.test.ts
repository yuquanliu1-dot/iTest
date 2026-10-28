import { describe, it, expect } from 'vitest';
import type { Page } from 'playwright-core';
import { extractPageElements, rankPageElements } from '../src/pi/inspectPage.js';
import type { RawElementCandidate } from '../src/pi/inspectPage.js';

function fakePage(evaluates: unknown, url = 'http://x/y') {
  return { url: () => url, evaluate: async () => evaluates } as unknown as Page;
}

function cand(p: Partial<RawElementCandidate> & { tag: string; selector: string }): RawElementCandidate {
  return {
    type: '', id: '', name: '', role: '', text: '', placeholder: '', aria: '', titleAttr: '', testid: '',
    editable: false, ...p,
  };
}

describe('extractPageElements', () => {
  it('返回 url/title/bodyLen/elements/truncated 快照形状（candidates→格式化清单+折叠计数）', async () => {
    const snap = await extractPageElements(
      fakePage({
        title: '元素管理',
        bodyLen: 320,
        overflow: false,
        candidates: [
          cand({ tag: 'button', id: 'add', text: '添加元素', selector: '#add' }),
          cand({ tag: 'input', type: 'checkbox', selector: 'input[type="checkbox"]' }),
          cand({ tag: 'input', type: 'checkbox', selector: 'input[type="checkbox"]' }),
        ],
      }),
      'http://192.168.30.228:8088/element-manager',
    );
    expect(snap.url).toBe('http://192.168.30.228:8088/element-manager');
    expect(snap.title).toBe('元素管理');
    expect(snap.bodyLen).toBe(320);
    expect(snap.candidateCount).toBe(3);
    expect(snap.truncated).toBe(false); // 去重折叠不算截断
    expect(snap.elements[0]).toContain('button#add');
    expect(snap.elements[0]).toContain('"添加元素"');
    // 同选择器复选框折叠成一条 ×2
    expect(snap.elements.filter((l) => l.includes('checkbox'))).toHaveLength(1);
    expect(snap.elements.find((l) => l.includes('checkbox'))).toContain('×2');
  });

  it('浏览器端候选溢出(overflow)时 truncated=true', async () => {
    const snap = await extractPageElements(
      fakePage({ title: 'x', bodyLen: 10, overflow: true, candidates: [cand({ tag: 'a', selector: 'a' })] }),
    );
    expect(snap.truncated).toBe(true);
  });
});

describe('rankPageElements（树表格页降噪）', () => {
  /** 事件管理页形态：工具栏按钮+搜索框 + 200 个 role=treeitem 行 + 30 个无名复选框 */
  function incidentMgrRaw(): RawElementCandidate[] {
    const raw: RawElementCandidate[] = [
      cand({ tag: 'button', id: 'create', text: '新建', selector: '#create' }),
      cand({ tag: 'button', text: '删除', selector: 'text=删除' }),
      cand({ tag: 'button', text: '导入', selector: 'text=导入' }),
      cand({ tag: 'button', text: '导出', selector: 'text=导出' }),
      cand({ tag: 'button', text: '查询', selector: 'text=查询' }),
      cand({ tag: 'input', placeholder: '请输入事件名称', selector: 'text=请输入事件名称' }),
    ];
    for (let i = 0; i < 200; i++) raw.push(cand({ tag: 'div', role: 'treeitem', text: `事件${i}`, selector: `text=事件${i}` }));
    for (let i = 0; i < 30; i++) raw.push(cand({ tag: 'input', type: 'checkbox', selector: 'input[type="checkbox"]' }));
    return raw;
  }

  it('工具栏按钮/搜索框浮到清单前部，不再被 treeitem 行淹没', () => {
    const { elements } = rankPageElements(incidentMgrRaw());
    const head = elements.slice(0, 6).join('\n');
    for (const label of ['新建', '删除', '导入', '导出', '查询', '请输入事件名称']) {
      expect(head).toContain(label);
    }
  });

  it('纯 [role] 容器限 12 条、复选框折叠 1 条 ×30，被省略量与类别进摘要', () => {
    const { elements, suppressed, suppressedSummary } = rankPageElements(incidentMgrRaw());
    expect(elements.filter((l) => l.includes('role=treeitem')).length).toBeLessThanOrEqual(12);
    const checkboxLines = elements.filter((l) => l.includes('checkbox'));
    expect(checkboxLines).toHaveLength(1);
    expect(checkboxLines[0]).toContain('×30');
    expect(suppressed).toBeGreaterThanOrEqual(188); // 200 treeitem 截留 188（按 score 可能再留更少）
    expect(suppressedSummary).toContain('role=treeitem ×');
  });

  it('动作控件超总量上限（90）时省略并计入摘要', () => {
    const raw: RawElementCandidate[] = [];
    for (let i = 0; i < 100; i++) raw.push(cand({ tag: 'button', text: `操作${i}`, selector: `text=操作${i}` }));
    const { elements, suppressed, suppressedSummary } = rankPageElements(raw);
    expect(elements.length).toBeLessThanOrEqual(90);
    expect(suppressed).toBeGreaterThanOrEqual(10);
    expect(suppressedSummary).toContain('button ×');
  });

  it('actionable role 的容器（role=button 等）按动作控件对待，不吃 structure 限额', () => {
    const raw = [
      cand({ tag: 'div', role: 'button', text: '确定', selector: 'text=确定' }),
      ...Array.from({ length: 30 }, (_, i) => cand({ tag: 'div', role: 'treeitem', text: `行${i}`, selector: `text=行${i}` })),
    ];
    const { elements } = rankPageElements(raw);
    expect(elements[0]).toContain('确定');
    expect(elements.filter((l) => l.includes('treeitem')).length).toBeLessThanOrEqual(12);
  });
});
