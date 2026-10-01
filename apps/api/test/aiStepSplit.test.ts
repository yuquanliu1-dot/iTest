import { describe, it, expect } from 'vitest';
import { splitByNumber } from '../src/agent/aiStepSplit.js';

describe('splitByNumber', () => {
  it('returns the original when no numbered lines present', () => {
    expect(splitByNumber('在搜索框输入"测试项目"')).toEqual(['在搜索框输入"测试项目"']);
  });

  it('splits a single numbered list (dot form) into separate instructions', () => {
    expect(
      splitByNumber('1. 在搜索框输入"测试项目"\n2. 点击查询\n3. 打开第一条结果详情'),
    ).toEqual([
      '在搜索框输入"测试项目"',
      '点击查询',
      '打开第一条结果详情',
    ]);
  });

  it('splits a single numbered list (、form)', () => {
    expect(
      splitByNumber('1、打开下拉框选择 MySQL\n2、打开下拉框选择 PostgreSQL\n3、点击保存'),
    ).toEqual([
      '打开下拉框选择 MySQL',
      '打开下拉框选择 PostgreSQL',
      '点击保存',
    ]);
  });

  it('keeps multi-line content within each numbered segment', () => {
    expect(
      splitByNumber('1. 第一行\n第二行\n2. 第三行\n第四行'),
    ).toEqual(['第一行\n第二行', '第三行\n第四行']);
  });

  it('ignores a single numbered segment (returns original)', () => {
    expect(splitByNumber('1. 只有一条')).toEqual(['1. 只有一条']);
  });

  it('keeps prose with "1" mid-sentence intact (not a list)', () => {
    expect(splitByNumber('处理完 1 个项目后点击确定')).toEqual(['处理完 1 个项目后点击确定']);
  });
});
