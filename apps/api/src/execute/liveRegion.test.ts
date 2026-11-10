import { describe, it, expect } from 'vitest';
import { diffNewMessages, hasObservableChange, type ChangeSnapshot } from './liveRegion.js';

describe('diffNewMessages - 新增消息差分（toast 一手证据）', () => {
  it('before 为空 → after 全部算新；旧消息剔除', () => {
    expect(diffNewMessages([], ['保存成功', '加载完成'])).toEqual(['保存成功', '加载完成']);
    expect(diffNewMessages(['旧消息'], ['保存成功'])).toEqual(['保存成功']);
  });

  it('逐字重复剔除', () => {
    expect(diffNewMessages(['保存成功'], ['保存成功'])).toEqual([]);
  });

  it('对称子串包含剔除：log 区域增长（after ⊃ before）与 toast 渐隐截断（after ⊂ before）都算旧', () => {
    expect(diffNewMessages(['第1行完成'], ['第1行完成 第2行完成'])).toEqual([]);
    expect(diffNewMessages(['保存成功，即将跳转'], ['保存成功'])).toEqual([]);
  });

  it('混合去重：顺序保持，只留真正新增', () => {
    const r = diffNewMessages(['旧的A', '旧的B'], ['旧的B', '新的C', '旧的A']);
    expect(r).toEqual(['新的C']);
  });
});

describe('hasObservableChange - 可观测变化闸（explorbot 四路口径）', () => {
  const snap = (over: Partial<ChangeSnapshot>): ChangeSnapshot => ({
    url: 'http://x/a',
    fingerprint: 100,
    requests: 5,
    messages: [],
    ...over,
  });

  it('四路全等 + 无新消息 = 无变化（无效点击）', () => {
    expect(hasObservableChange(snap({}), snap({}), [])).toBe(false);
  });

  it('任一路变化即过闸', () => {
    expect(hasObservableChange(snap({}), snap({ url: 'http://x/b' }), [])).toBe(true);
    expect(hasObservableChange(snap({}), snap({ fingerprint: 101 }), [])).toBe(true);
    expect(hasObservableChange(snap({}), snap({ requests: 6 }), [])).toBe(true);
    expect(hasObservableChange(snap({}), snap({}), ['弹窗文本'])).toBe(true);
  });
});
