import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { detectComponent } from '../modules/component-detector.js';

let document: Document;
beforeEach(() => {
  document = new JSDOM('<!doctype html><html><body></body></html>').window.document;
});
function makeEl(html: string): Element {
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  return wrap.firstElementChild!;
}

describe('component-detector', () => {
  it('detects antd select', () => {
    const el = makeEl('<div><span class="ant-select-selection"></span></div>');
    expect(detectComponent(el.firstElementChild!)).toEqual({ lib: 'antd', kind: 'select' });
  });
  it('detects element-plus select', () => {
    const el = makeEl('<div class="el-select"><input /></div>');
    expect(detectComponent(el)).toEqual({ lib: 'element', kind: 'select' });
  });
  it('detects iview select', () => {
    const el = makeEl('<div class="ivu-select"></div>');
    expect(detectComponent(el)).toEqual({ lib: 'iview', kind: 'select' });
  });
  it('detects antd tree', () => {
    const el = makeEl('<div class="ant-tree"></div>');
    expect(detectComponent(el)).toEqual({ lib: 'antd', kind: 'tree' });
  });
  it('detects element tree-select', () => {
    const el = makeEl('<div class="el-tree-select"></div>');
    expect(detectComponent(el)).toEqual({ lib: 'element', kind: 'treeSelect' });
  });
  it('returns null for vanilla', () => {
    const el = makeEl('<div class="plain"></div>');
    expect(detectComponent(el)).toBeNull();
  });
});