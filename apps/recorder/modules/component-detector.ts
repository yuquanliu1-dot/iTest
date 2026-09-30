export type ComponentLib = 'antd' | 'element' | 'iview';
export type ComponentKind = 'select' | 'tree' | 'treeSelect';

export interface ComponentInfo {
  lib: ComponentLib;
  kind: ComponentKind;
}

const RULES: Array<{ lib: ComponentLib; kind: ComponentKind; test: (cls: string) => boolean }> = [
  { lib: 'antd', kind: 'treeSelect', test: (c) => c.startsWith('ant-tree-select') },
  { lib: 'antd', kind: 'tree', test: (c) => c.startsWith('ant-tree') },
  { lib: 'antd', kind: 'select', test: (c) => c.startsWith('ant-select') },
  { lib: 'element', kind: 'treeSelect', test: (c) => c.startsWith('el-tree-select') },
  { lib: 'element', kind: 'tree', test: (c) => c.startsWith('el-tree') },
  { lib: 'element', kind: 'select', test: (c) => c.startsWith('el-select') },
  { lib: 'iview', kind: 'treeSelect', test: (c) => c.startsWith('ivu-tree-select') },
  { lib: 'iview', kind: 'tree', test: (c) => c.startsWith('ivu-tree') },
  { lib: 'iview', kind: 'select', test: (c) => c.startsWith('ivu-select') },
];

/** 沿父链向上搜索，直到命中任意一条规则或到根。 */
export function detectComponent(el: Element | null): ComponentInfo | null {
  let cur: Element | null = el;
  while (cur) {
    const cls = (cur.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
    for (const c of cls) {
      for (const r of RULES) {
        if (r.test(c)) return { lib: r.lib, kind: r.kind };
      }
    }
    cur = cur.parentElement;
  }
  return null;
}