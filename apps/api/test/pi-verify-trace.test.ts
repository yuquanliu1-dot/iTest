import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AiAction } from '../src/execute/aiTask.js';
import type { EffectiveStep } from '../src/pi/space/tools/case-ops-tools.js';

// 轨迹缓存纯单测（无 DB/浏览器）：新鲜度矩阵 + TTL + 容量淘汰 + 哈希确定性。
// takeFreshTrace 的过期副作用（删条目）也在矩阵内断言。各用例用不同 key 隔离模块级 Map。
describe('verifyTrace', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const step = (over: Partial<EffectiveStep>): EffectiveStep =>
    ({
      id: 's1',
      order: 1,
      instruction: '点击提交',
      compiled: null,
      assertion: null,
      sensitive: false,
      delayMs: null,
      secretCiphertext: null,
      secretIv: null,
      secretTag: null,
      ...over,
    }) as EffectiveStep;

  const act = (a: Partial<AiAction> & { type: AiAction['type'] }): AiAction => a as AiAction;

  async function mod() {
    return import('../src/pi/space/tools/verifyTrace.js');
  }

  it('新鲜轨迹命中返回 trace；required id 全在册是硬条件', async () => {
    const m = await mod();
    const stepsHash = ['h1', 'h2'];
    const trace = new Map<string, AiAction[]>([['s1', [act({ type: 'click', selector: '#btn' })]]]);
    m.saveVerifiedTrace('k1', stepsHash, 'meta', trace);
    const got = m.takeFreshTrace('k1', stepsHash, 'meta', ['s1']);
    expect(got).not.toBeNull();
    expect(got!.get('s1')!.length).toBe(1);
    // required 缺 s1（缓存里没有）→ 判过期并删条目
    expect(m.takeFreshTrace('k1', stepsHash, 'meta', ['s1', 's2'])).toBeNull();
    expect(m.getVerifiedTrace('k1')).toBeNull();
  });

  it('stepsHash 逐元素不等 / 长度不等 / metaHash 不等 → 过期删除', async () => {
    const m = await mod();
    const trace = new Map<string, AiAction[]>([['s1', []]]);
    m.saveVerifiedTrace('k2', ['h1', 'h2'], 'meta', trace);
    expect(m.takeFreshTrace('k2', ['h1', 'hX'], 'meta', ['s1'])).toBeNull();
    // 已被上一行删除
    expect(m.takeFreshTrace('k2', ['h1', 'h2'], 'meta', ['s1'])).toBeNull();

    m.saveVerifiedTrace('k3', ['h1'], 'meta', new Map([['s1', []]]));
    expect(m.takeFreshTrace('k3', ['h1', 'h2'], 'meta', ['s1'])).toBeNull(); // 长度不等

    m.saveVerifiedTrace('k4', ['h1'], 'meta', new Map([['s1', []]]));
    expect(m.takeFreshTrace('k4', ['h1'], 'meta2', ['s1'])).toBeNull(); // meta 变 = 换被测对象
  });

  it('TTL 30 分钟：29 分钟命中，31 分钟过期删除', async () => {
    const m = await mod();
    m.saveVerifiedTrace('k5', ['h1'], 'meta', new Map([['s1', []]]));
    vi.advanceTimersByTime(29 * 60_000);
    expect(m.takeFreshTrace('k5', ['h1'], 'meta', ['s1'])).not.toBeNull();
    m.saveVerifiedTrace('k5', ['h1'], 'meta', new Map([['s1', []]]));
    vi.advanceTimersByTime(31 * 60_000);
    expect(m.takeFreshTrace('k5', ['h1'], 'meta', ['s1'])).toBeNull();
    expect(m.getVerifiedTrace('k5')).toBeNull();
  });

  it('容量 64：第 65 条写入淘汰最旧', async () => {
    const m = await mod();
    for (let i = 0; i < 64; i++) {
      m.saveVerifiedTrace(`k-${i}`, [`h${i}`], 'meta', new Map());
      vi.advanceTimersByTime(1000); // savedAt 拉开差距
    }
    expect(m.getVerifiedTrace('k-0')).not.toBeNull();
    m.saveVerifiedTrace('k-64', ['h64'], 'meta', new Map()); // 触发淘汰 k-0
    expect(m.getVerifiedTrace('k-0')).toBeNull();
    expect(m.getVerifiedTrace('k-1')).not.toBeNull();
    expect(m.getVerifiedTrace('k-64')).not.toBeNull();
  });

  it('hashEffectiveSteps：字段任一变化哈希变；同输入确定', async () => {
    const m = await mod();
    const base = step({});
    const h1 = m.hashEffectiveSteps([base]);
    expect(m.hashEffectiveSteps([step({})])).toEqual(h1);
    expect(m.hashEffectiveSteps([step({ instruction: '点击保存' })])[0]).not.toBe(h1[0]);
    expect(m.hashEffectiveSteps([step({ compiled: [{ kind: 'click' }] })])[0]).not.toBe(h1[0]);
    expect(m.hashEffectiveSteps([step({ assertion: '出现成功提示' })])[0]).not.toBe(h1[0]);
    expect(m.hashEffectiveSteps([step({ sensitive: true })])[0]).not.toBe(h1[0]);
    expect(m.hashEffectiveSteps([step({ delayMs: 500 })])[0]).not.toBe(h1[0]);
  });

  it('hashVerifyMeta：url/env/version 任一变化哈希变', async () => {
    const m = await mod();
    const h = m.hashVerifyMeta({ url: 'https://a', defaultEnvId: 'e1', versionId: 'v1' });
    expect(m.hashVerifyMeta({ url: 'https://a', defaultEnvId: 'e1', versionId: 'v1' })).toBe(h);
    expect(m.hashVerifyMeta({ url: 'https://b', defaultEnvId: 'e1', versionId: 'v1' })).not.toBe(h);
    expect(m.hashVerifyMeta({ url: null, defaultEnvId: 'e1', versionId: 'v1' })).not.toBe(h);
    expect(m.hashVerifyMeta({ url: 'https://a', defaultEnvId: null, versionId: 'v1' })).not.toBe(h);
    expect(m.hashVerifyMeta({ url: 'https://a', defaultEnvId: 'e1', versionId: null })).not.toBe(h);
  });

  it('traceKey 与 clearVerifiedTrace', async () => {
    const m = await mod();
    expect(m.traceKey('t1', 'c1')).toBe('t1::c1');
    m.saveVerifiedTrace('k6', ['h'], 'meta', new Map());
    m.clearVerifiedTrace('k6');
    expect(m.getVerifiedTrace('k6')).toBeNull();
  });
});
