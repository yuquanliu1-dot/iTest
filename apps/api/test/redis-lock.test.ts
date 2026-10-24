import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * redisLock 单元测试（仿 live-view-bus.test.ts 的 REDIS_URL 开关 + vi.doMock('ioredis') 法）：
 * - 无 REDIS_URL → 恒成功锁（release/refresh 可调、refresh=true）；
 * - 有 REDIS_URL（fake）：SET NX PX 参数、拿不到 → null、set 报错 → null（降级）、
 *   release/refresh 走 Lua 比对 token、refresh 丢失/报错 → false。
 * scheduler/repo/threadBus 的接线是薄封装，行为由本文件的锁原语 + 各自路由测试兜底。
 * 注意：被测模块只走动态导入（顶部静态导入会让 doMock 后的重载拿到真 ioredis 实例，
 * 同 live-view-bus.test.ts 的做法）。 */

class FakeRedis {
  static all: FakeRedis[] = [];
  calls: Record<string, unknown[][]> = {};
  /** 覆写返回值（Error → reject）；未覆写时用 per-command 默认（set→'OK'、eval→1，同真 Redis 成功语义）。 */
  results: Record<string, unknown> = {};
  static DEFAULTS: Record<string, unknown> = { set: 'OK', eval: 1 };
  constructor() {
    FakeRedis.all.push(this);
    // biome-ignore lint/suspicious/noExplicitAny: 按命令名记账
    const rec = (cmd: string) => (...args: any[]) => {
      (this.calls[cmd] ??= []).push(args);
      const v = cmd in this.results ? this.results[cmd] : FakeRedis.DEFAULTS[cmd];
      if (v instanceof Error) return Promise.reject(v);
      return Promise.resolve(v);
    };
    this.set = rec('set');
    this.eval = rec('eval');
  }
  set: (...args: unknown[]) => Promise<unknown>;
  eval: (...args: unknown[]) => Promise<unknown>;
  on(_e: string, _cb: (...a: never[]) => void) { return this; }
  callsOf(cmd: string): unknown[][] {
    return this.calls[cmd] ?? [];
  }
}

async function freshLockWithFake() {
  vi.resetModules();
  FakeRedis.all = [];
  vi.doMock('ioredis', () => ({ default: FakeRedis }));
  return import('../src/lib/redisLock.js');
}

describe('无 REDIS_URL → 恒成功锁', () => {
  beforeEach(() => { delete process.env.REDIS_URL; });

  it('acquire 返回锁；release/refresh 可调且 refresh=true', async () => {
    const mod = await import('../src/lib/redisLock.js');
    const lock = await mod.tryAcquireLock('itest:t:1', 1000);
    expect(lock).not.toBeNull();
    await expect(lock!.refresh()).resolves.toBe(true);
    await expect(lock!.release()).resolves.toBeUndefined();
  });
});

describe('有 REDIS_URL（fake ioredis）', () => {
  beforeEach(() => { process.env.REDIS_URL = 'redis://localhost:6379'; });
  afterEach(() => {
    delete process.env.REDIS_URL;
    vi.doUnmock('ioredis');
    vi.restoreAllMocks();
  });

  it('SET NX PX 参数正确；占用中被抢 → null', async () => {
    const mod = await freshLockWithFake();
    const lock = await mod.tryAcquireLock('itest:t:2', 5000);
    expect(lock).not.toBeNull();
    const redis = FakeRedis.all[0]!;
    expect(redis.callsOf('set')[0]).toEqual(['itest:t:2', mod.ORIGIN_ID, 'PX', 5000, 'NX']);

    redis.results.set = null; // NX 失败（他副本持有）
    await expect(mod.tryAcquireLock('itest:t:2', 5000)).resolves.toBeNull();
  });

  it('set 报错 → null（连接失败按拿不到降级，不留半把锁）', async () => {
    const mod = await freshLockWithFake();
    // 先触发一次拿锁完成惰性构造，再覆写返回值
    await expect(mod.tryAcquireLock('itest:t:3', 1000)).resolves.not.toBeNull();
    const redis = FakeRedis.all[0]!;
    redis.results.set = new Error('down');
    await expect(mod.tryAcquireLock('itest:t:3', 1000)).resolves.toBeNull();
  });

  it('release/refresh 走 Lua 比对 token；refresh 0/报错 → false', async () => {
    const mod = await freshLockWithFake();
    const lock = await mod.tryAcquireLock('itest:t:4', 1000);
    const redis = FakeRedis.all[0]!;

    await lock!.refresh();
    let [script, numkeys, key, token, ttl] = redis.callsOf('eval')[0]! as [string, number, string, string, number];
    expect(script).toContain('pexpire');
    expect(numkeys).toBe(1);
    expect(key).toBe('itest:t:4');
    expect(token).toBe(mod.ORIGIN_ID);
    expect(ttl).toBe(1000);

    redis.results.eval = 0; // 锁已丢
    await expect(lock!.refresh()).resolves.toBe(false);
    redis.results.eval = new Error('down');
    await expect(lock!.refresh()).resolves.toBe(false);

    redis.results.eval = 1;
    await lock!.release();
    const rel = redis.callsOf('eval').at(-1)! as [string, number, string, string];
    expect(rel[0]).toContain('del');
    expect(rel[2]).toBe('itest:t:4');
    expect(rel[3]).toBe(mod.ORIGIN_ID);
    await expect(lock!.release()).resolves.toBeUndefined(); // 报错路径也不抛
  });

  it('ORIGIN_ID 进程内稳定且为 UUID 形状（同 registry 实例复用，不因重复 import 再生）', async () => {
    const m1 = await import('../src/lib/redisLock.js');
    const m2 = await import('../src/lib/redisLock.js');
    expect(m2.ORIGIN_ID).toBe(m1.ORIGIN_ID);
    expect(m1.ORIGIN_ID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
