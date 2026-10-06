/**
 * Cache 模块单元测试。REDIS_URL 未设置 → client = null → wrap 走 loader,del/delPattern no-op。
 * 直接 mock ioredis 实例绕开真实连接,验证 wrap 的 hit / miss / set / del / delPattern 行为。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { __resetClientForTests, __setClientForTests, cache, del, delPattern, wrap } from '../src/lib/cache.js';

// 不依赖真实 redis。REDIS_URL 不设置时 getClient 走 null 分支。
delete process.env.REDIS_URL;

interface FakeRedis {
  store: Map<string, { value: string; expiresAt: number }>;
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, mode: 'PX', ttl: number) => Promise<'OK'>;
  scan: (cursor: string, ...args: unknown[]) => Promise<[string, string[]]>;
  del: (...keys: string[]) => Promise<number>;
  disconnect: () => void;
  on: (event: string, listener: (...a: unknown[]) => void) => void;
  connect: () => Promise<void>;
  ping: () => Promise<string>;
}

function makeFakeRedis(): FakeRedis {
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
    store,
    get: async (key) => {
      const e = store.get(key);
      if (!e) return null;
      if (e.expiresAt && e.expiresAt < Date.now()) {
        store.delete(key);
        return null;
      }
      return e.value;
    },
    set: async (key, v, _mode, ttl) => {
      store.set(key, { value: v, expiresAt: Date.now() + ttl });
      return 'OK' as const;
    },
    scan: async (cursor, ...args) => {
      // 命令签名 [cursor, 'MATCH', pattern, 'COUNT', n] 或 [cursor, ...] 占位
      const matchIdx = args.indexOf('MATCH');
      const pattern = matchIdx >= 0 ? String(args[matchIdx + 1] ?? '') : '';
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      const keys = [...store.keys()].filter((k) => regex.test(k));
      return [cursor === '0' ? '0' : '0', keys] as [string, string[]];
    },
    del: async (...keys) => {
      let n = 0;
      for (const k of keys) if (store.delete(k)) n++;
      return n;
    },
    disconnect: () => {},
    on: () => {},
    connect: async () => {},
    ping: async () => 'PONG',
  };
}

afterEach(() => {
  __resetClientForTests();
  delete process.env.REDIS_URL;
});

describe('cache.wrap', () => {
  it('未配置 REDIS_URL 时直接调用 loader', async () => {
    const loader = vi.fn(async () => ({ value: 1 }));
    const out = await wrap('k1', 30_000, loader);
    expect(out).toEqual({ value: 1 });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('命中缓存时不调用 loader', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const fake = makeFakeRedis();
    __setClientForTests(fake as unknown as Parameters<typeof __setClientForTests>[0]);
    // 预填命中值
    fake.store.set('k2', { value: JSON.stringify({ value: 42 }), expiresAt: Date.now() + 30_000 });

    const loader = vi.fn(async () => ({ value: 99 }));
    const out = await wrap('k2', 30_000, loader);
    expect(out).toEqual({ value: 42 });
    expect(loader).not.toHaveBeenCalled();
  });

  it('未命中 → loader → 回填', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const fake = makeFakeRedis();
    __setClientForTests(fake as unknown as Parameters<typeof __setClientForTests>[0]);

    const loader = vi.fn(async () => ({ value: 7 }));
    const out = await wrap('k3', 30_000, loader);
    expect(out).toEqual({ value: 7 });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(fake.store.get('k3')?.value).toBe(JSON.stringify({ value: 7 }));

    // 第二次命中
    const loader2 = vi.fn(async () => ({ value: 999 }));
    const out2 = await wrap('k3', 30_000, loader2);
    expect(out2).toEqual({ value: 7 });
    expect(loader2).not.toHaveBeenCalled();
  });

  it('loader 返回 null 不回填', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const fake = makeFakeRedis();
    __setClientForTests(fake as unknown as Parameters<typeof __setClientForTests>[0]);

    const out = await wrap<string | null>('k4', 30_000, async () => null);
    expect(out).toBeNull();
    expect(fake.store.has('k4')).toBe(false);
  });

  it('loader 抛错原样向上,不影响 wrap', async () => {
    const out = wrap('k5', 30_000, async () => {
      throw new Error('boom');
    });
    await expect(out).rejects.toThrow('boom');
  });
});

describe('cache.del / delPattern', () => {
  it('未配置 redis 时 no-op', async () => {
    await expect(del('x')).resolves.toBeUndefined();
    await expect(delPattern('x:*')).resolves.toBeUndefined();
  });

  it('del 删除单 key', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const fake = makeFakeRedis();
    __setClientForTests(fake as unknown as Parameters<typeof __setClientForTests>[0]);
    fake.store.set('a', { value: '"1"', expiresAt: 0 });
    fake.store.set('b', { value: '"2"', expiresAt: 0 });
    await del('a');
    expect(fake.store.has('a')).toBe(false);
    expect(fake.store.has('b')).toBe(true);
  });

  it('delPattern 匹配通配', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const fake = makeFakeRedis();
    __setClientForTests(fake as unknown as Parameters<typeof __setClientForTests>[0]);
    fake.store.set('tags:1', { value: '[]', expiresAt: 0 });
    fake.store.set('tags:2', { value: '[]', expiresAt: 0 });
    fake.store.set('settings:all', { value: '{}', expiresAt: 0 });
    await delPattern('tags:*');
    expect(fake.store.has('tags:1')).toBe(false);
    expect(fake.store.has('tags:2')).toBe(false);
    expect(fake.store.has('settings:all')).toBe(true);
  });
});

describe('cache exported helper', () => {
  it('cache.del / cache.delPattern 与裸函数一致', () => {
    expect(cache.del).toBe(del);
    expect(cache.delPattern).toBe(delPattern);
  });
});