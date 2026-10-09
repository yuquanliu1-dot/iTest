import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 进程内登录态缓存：存取、TTL 过期、key 规则。模块级 Map,各用例用不同 key 隔离。
describe('loginStateCache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('存取一致；未命中/异 key 返回 null', async () => {
    const { getLoginState, saveLoginState } = await import('../src/pi/space/tools/loginStateCache.js');
    expect(getLoginState('e1:qa')).toBeNull();
    const state = { cookies: [{ name: 'sid', value: 'a' }], origins: [] };
    saveLoginState('e1:qa', state as never);
    expect(getLoginState('e1:qa')).toEqual(state);
    expect(getLoginState('e1:other')).toBeNull();
  });

  it('TTL 30 分钟:29 分钟仍命中,31 分钟过期', async () => {
    const { getLoginState, saveLoginState } = await import('../src/pi/space/tools/loginStateCache.js');
    saveLoginState('e2:qa', { cookies: [], origins: [] } as never);
    vi.advanceTimersByTime(29 * 60_000);
    expect(getLoginState('e2:qa')).not.toBeNull();
    vi.advanceTimersByTime(2 * 60_000);
    expect(getLoginState('e2:qa')).toBeNull();
  });

  it('loginStateKey：user 为空时 key 稳定', async () => {
    const { loginStateKey } = await import('../src/pi/space/tools/loginStateCache.js');
    expect(loginStateKey('e3', undefined)).toBe('e3:');
    expect(loginStateKey('e3', 'qa01')).toBe('e3:qa01');
  });
});
