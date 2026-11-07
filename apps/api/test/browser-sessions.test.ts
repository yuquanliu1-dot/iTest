import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import {
  acquire,
  commit,
  invalidate,
  sweepOnce,
  peekSession,
  resetForTest,
} from '../src/pi/space/tools/browserSessions.js';

function fakeBrowser(connected = true): { browser: Browser; close: ReturnType<typeof vi.fn> } {
  const close = vi.fn().mockResolvedValue(undefined);
  return { browser: { isConnected: () => connected, close } as unknown as Browser, close };
}
const fakePage = (closed = false) => ({ isClosed: () => closed }) as unknown as Page;
const fakeContext = () => ({}) as unknown as BrowserContext;

const HASH = ['h0', 'h1', 'h2'];
const META = 'meta-a';

function put(key: string, opts: { connected?: boolean; pageClosed?: boolean; hashes?: string[] } = {}): ReturnType<typeof fakeBrowser> {
  const fb = fakeBrowser(opts.connected ?? true);
  commit(key, { browser: fb.browser, context: fakeContext(), page: fakePage(opts.pageClosed ?? false) }, META, opts.hashes ?? HASH);
  return fb;
}

beforeEach(() => {
  resetForTest();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-07T00:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('acquire 命中矩阵', () => {
  it('全条件满足返回三件套 + appliedCount，同引用', () => {
    const fb = put('k1', { hashes: HASH.slice(0, 2) });
    const got = acquire('k1', META, HASH);
    expect(got).not.toBeNull();
    expect(got!.browser).toBe(fb.browser);
    expect(got!.appliedCount).toBe(2);
  });

  it('metaHash 失配 → 销毁降级', () => {
    const fb = put('k2');
    expect(acquire('k2', 'meta-other', HASH)).toBeNull();
    expect(fb.close).toHaveBeenCalledTimes(1);
  });

  it('appliedHashes 中段分歧（非前缀）→ 销毁降级', () => {
    const fb = put('k3', { hashes: ['h0', 'x1'] });
    expect(acquire('k3', META, HASH)).toBeNull();
    expect(fb.close).toHaveBeenCalledTimes(1);
  });

  it('appliedHashes 长度超当前步骤 → 销毁降级', () => {
    const fb = put('k4', { hashes: [...HASH, 'h3'] });
    expect(acquire('k4', META, HASH)).toBeNull();
    expect(fb.close).toHaveBeenCalledTimes(1);
  });

  it('TTL 过期 → 销毁降级', () => {
    const fb = put('k5');
    vi.advanceTimersByTime(20 * 60 * 1000 + 1);
    expect(acquire('k5', META, HASH)).toBeNull();
    expect(fb.close).toHaveBeenCalledTimes(1);
  });

  it('browser 断连 / page 已关 → 销毁降级', () => {
    const fb = put('k6', { connected: false });
    expect(acquire('k6', META, HASH)).toBeNull();
    expect(fb.close).toHaveBeenCalledTimes(1);
    const fb2 = put('k7', { pageClosed: true });
    expect(acquire('k7', META, HASH)).toBeNull();
    expect(fb2.close).toHaveBeenCalledTimes(1);
  });

  it('TTL 边界内仍命中，且 touch lastUsedAt', () => {
    const fb = put('k8');
    vi.advanceTimersByTime(20 * 60 * 1000 - 1);
    expect(acquire('k8', META, HASH)).not.toBeNull();
    const rec = peekSession('k8')!;
    expect(rec.lastUsedAt).toBe(Date.now());
    expect(fb.close).not.toHaveBeenCalled();
  });
});

describe('commit / invalidate', () => {
  it('超 MAX_SESSIONS 淘汰 lastUsedAt 最旧（不含本次 key）', () => {
    const fbOld = put('old');
    vi.advanceTimersByTime(1000);
    put('mid');
    vi.advanceTimersByTime(1000);
    const fbNew = fakeBrowser();
    commit('new', { browser: fbNew.browser, context: fakeContext(), page: fakePage() }, META, []);
    expect(peekSession('old')).toBeNull(); // 最旧被淘汰
    expect(fbOld.close).toHaveBeenCalledTimes(1);
    expect(peekSession('mid')).not.toBeNull();
    expect(peekSession('new')).not.toBeNull();
  });

  it('同 key 覆盖更新 appliedHashes 且不触发淘汰', () => {
    put('k9', { hashes: HASH.slice(0, 1) });
    vi.advanceTimersByTime(1000);
    const fb2 = fakeBrowser();
    commit('k9', { browser: fb2.browser, context: fakeContext(), page: fakePage() }, META, HASH.slice(0, 2));
    expect(acquire('k9', META, HASH)?.appliedCount).toBe(2);
  });

  it('invalidate 幂等；下册后 acquire 返 null', () => {
    const fb = put('k10');
    invalidate('k10');
    invalidate('k10'); // 幂等
    expect(fb.close).toHaveBeenCalledTimes(1);
    expect(acquire('k10', META, HASH)).toBeNull();
  });
});

describe('sweepOnce', () => {
  it('只清过期记录，未过期保留', () => {
    const fbKeep = put('keep');
    vi.advanceTimersByTime(20 * 60 * 1000 + 1);
    const fbGone = put('gone'); // 时间已在过期线之后，但 lastUsedAt 是刚 touch 的
    sweepOnce();
    expect(peekSession('keep')).toBeNull();
    expect(peekSession('gone')).not.toBeNull();
    expect(fbKeep.close).toHaveBeenCalledTimes(1);
    expect(fbGone.close).not.toHaveBeenCalled();
  });
});
