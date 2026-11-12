import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unit tests for threadBus (the Assistant/RCA thread cross-replica bridge).
 * Follows space-confirm.test.ts's vi.doMock('ioredis') + resetModules approach:
 * - One module instance = one replica; freshReplica dynamically imports redisLock.js at the same time,
 *   taking an ORIGIN_ID from the same registry cycle (a top-level static import after doMock is a different
 *   instance from threadBus's internal one, and must not be used to build/assert envelope origins).
 * - FakeRedis instances aren't interconnected: the publishing side captures (chan, msg) via callsOf and manually
 *   emits back to the subscribing side's connection (= simulating Redis dispatching a message to the subscribed replica).
 * The run-lock (itest:thread-run) SET NX / Lua primitives are covered by redis-lock.test.ts;
 * the session layer (same-replica steer re-entry / other-replica rejection) lives in space-session.test.ts.
 */

type ThreadBus = typeof import('../src/pi/space/threadBus.js');
type RedisLock = typeof import('../src/lib/redisLock.js');

class FakeRedis {
  static all: FakeRedis[] = [];
  listeners: Record<string, Array<(...args: never[]) => void>> = {};
  calls: Record<string, unknown[][]> = {};
  /** Override return values per command name (Error → reject); defaults to 0 (exists→0 = no lock; others swallowed by catch). */
  results: Record<string, unknown> = {};
  constructor() {
    FakeRedis.all.push(this);
  }
  on(evt: string, cb: (...args: never[]) => void) {
    (this.listeners[evt] ??= []).push(cb);
    return this;
  }
  emit(evt: string, ...args: unknown[]) {
    for (const cb of [...(this.listeners[evt] ?? [])]) (cb as (...a: unknown[]) => void)(...args);
  }
  private exec(cmd: string, args: unknown[]): Promise<unknown> {
    (this.calls[cmd] ??= []).push(args);
    const v = cmd in this.results ? this.results[cmd] : 0;
    if (v instanceof Error) return Promise.reject(v);
    return Promise.resolve(v);
  }
  publish(...args: unknown[]) { return this.exec('publish', args); }
  subscribe(...args: unknown[]) { return this.exec('subscribe', args); }
  unsubscribe(...args: unknown[]) { return this.exec('unsubscribe', args); }
  psubscribe(...args: unknown[]) { return this.exec('psubscribe', args); }
  exists(...args: unknown[]) { return this.exec('exists', args); }
  incr(...args: unknown[]) { return this.exec('incr', args); }
  get(...args: unknown[]) { return this.exec('get', args); }
  del(...args: unknown[]) { return this.exec('del', args); }
  callsOf(cmd: string): unknown[][] {
    return this.calls[cmd] ?? [];
  }
}

/** Dynamically load a (threadBus, redisLock) pair: same reset cycle → shared ORIGIN_ID. */
async function freshReplica(): Promise<{ bus: ThreadBus; lock: RedisLock }> {
  vi.resetModules();
  FakeRedis.all = [];
  vi.doMock('ioredis', () => ({ default: FakeRedis }));
  const [bus, lock] = await Promise.all([
    import('../src/pi/space/threadBus.js'),
    import('../src/lib/redisLock.js'),
  ]);
  return { bus, lock };
}

describe('无 REDIS_URL（本地 dev / vitest）全 no-op', () => {
  beforeEach(() => { delete process.env.REDIS_URL; });
  afterEach(() => { vi.doUnmock('ioredis'); });

  it('镜像订阅即时返回、发布/取消不建连、远端探测恒 false', async () => {
    const { bus } = await freshReplica();
    const got: unknown[] = [];
    const unsub = bus.subscribeThreadMirror('t1', (e) => got.push(e));
    expect(typeof unsub).toBe('function');
    expect(() => bus.publishThreadEvent('t1', { type: 'x' })).not.toThrow();
    expect(() => bus.publishThreadCancel('t1')).not.toThrow();
    unsub();
    expect(() => bus.startThreadCommandWatch(() => {})).not.toThrow();
    await expect(bus.threadRunRemote('t1')).resolves.toBe(false);
    expect(got).toHaveLength(0);
    expect(FakeRedis.all).toHaveLength(0); // zero connections the whole way
  });

  it('seq 分配/高水位:无 Redis 走进程内兜底计数,单调递增', async () => {
    const { bus } = await freshReplica();
    await expect(bus.allocateThreadSeq('t1')).resolves.toBe(1);
    await expect(bus.allocateThreadSeq('t1')).resolves.toBe(2);
    await expect(bus.currentThreadSeq('t1')).resolves.toBe(2);
    await expect(bus.currentThreadSeq('t-none')).resolves.toBe(0);
    expect(FakeRedis.all).toHaveLength(0); // zero connections the whole way
    bus.deleteThreadSeq('t1'); // local fallback cleared synchronously
    await expect(bus.currentThreadSeq('t1')).resolves.toBe(0);
  });
});

describe('有 REDIS_URL（fake ioredis）', () => {
  beforeEach(() => { process.env.REDIS_URL = 'redis://localhost:6379'; });
  afterEach(() => {
    delete process.env.REDIS_URL;
    vi.doUnmock('ioredis');
  });

  it('事件镜像:发布信封带本副本 origin;异源转发给订阅者,本副本回环与坏 JSON 跳过;退订记账', async () => {
    const A = await freshReplica();
    const B = await freshReplica();
    const got: unknown[] = [];
    const unsub = B.bus.subscribeThreadMirror('t1', (e) => got.push(e));
    // B's first subscription → SUBSCRIBE on the event channel (B's sub connection = all[0]; B's freshReplica just cleared all)
    const subB = FakeRedis.all[0]!;
    expect(subB.callsOf('subscribe')[0]).toEqual(['itest:thread-ev:t1']);

    // A publishes → capture the envelope (A's pub lazily built = all[1])
    A.bus.publishThreadEvent('t1', { type: 'verify_progress', seq: 1 });
    const pubA = FakeRedis.all[1]!;
    const [chan, msg] = pubA.callsOf('publish')[0]! as [string, string];
    expect(chan).toBe('itest:thread-ev:t1');
    const env = JSON.parse(msg) as { o: string; e: Record<string, unknown> };
    expect(env.o).toBe(A.lock.ORIGIN_ID);
    expect(env.e).toMatchObject({ type: 'verify_progress', seq: 1 });

    // Manually dispatch to B's subscribed connection = the hanging replica receives a foreign-origin event → forward
    subB.emit('message', chan, msg);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ type: 'verify_progress', seq: 1 });

    // Same-replica loopback: B published it itself (envelope origin = B) → not forwarded (local listeners already got it)
    B.bus.publishThreadEvent('t1', { type: 'x' });
    const pubB = FakeRedis.all[2]!;
    subB.emit('message', 'itest:thread-ev:t1', pubB.callsOf('publish')[0]![1] as string);
    expect(got).toHaveLength(1);

    // Bad JSON silently ignored (doesn't drag down dispatch)
    subB.emit('message', 'itest:thread-ev:t1', '{broken');
    expect(got).toHaveLength(1);

    // Unsubscribe → UNSUBSCRIBE recorded
    unsub();
    expect(subB.callsOf('unsubscribe')[0]).toEqual(['itest:thread-ev:t1']);
  });

  it('镜像引用计数:多订阅者共享一次 SUBSCRIBE,末个退订才 UNSUBSCRIBE;退订幂等', async () => {
    const { bus } = await freshReplica();
    const u1 = bus.subscribeThreadMirror('t1', () => {});
    const u2 = bus.subscribeThreadMirror('t1', () => {});
    const sub = FakeRedis.all[0]!;
    expect(sub.callsOf('subscribe')).toHaveLength(1);
    u1();
    expect(sub.callsOf('unsubscribe')).toHaveLength(0);
    u2();
    expect(sub.callsOf('unsubscribe')).toHaveLength(1);
    u2(); // idempotent: calling again doesn't unsubscribe twice
    expect(sub.callsOf('unsubscribe')).toHaveLength(1);
  });

  it('cancel 命令:异源派发给 handler,本副本回环跳过;重复 watch 只换 handler 不重复 PSUBSCRIBE', async () => {
    const A = await freshReplica();
    const B = await freshReplica();
    const aborted: string[] = [];
    B.bus.startThreadCommandWatch((id) => aborted.push(id));
    const subB = FakeRedis.all[0]!;
    expect(subB.callsOf('psubscribe')[0]).toEqual(['itest:thread-cmd:*']);

    // A initiates cancel (value = initiating replica's ORIGIN_ID) → B receives a foreign-origin message → handler runs
    A.bus.publishThreadCancel('t9');
    const pubA = FakeRedis.all[1]!;
    const [chan, msg] = pubA.callsOf('publish')[0]! as [string, string];
    expect(chan).toBe('itest:thread-cmd:t9');
    expect(msg).toBe(A.lock.ORIGIN_ID);
    subB.emit('pmessage', 'itest:thread-cmd:*', chan, msg);
    expect(aborted).toEqual(['t9']);

    // What B itself broadcast (loopback; the local fast path already aborted) is skipped
    B.bus.publishThreadCancel('t8');
    const pubB = FakeRedis.all[2]!;
    subB.emit('pmessage', 'itest:thread-cmd:*', 'itest:thread-cmd:t8', pubB.callsOf('publish')[0]![1] as string);
    expect(aborted).toEqual(['t9']);

    // Repeat watch: only the handler is replaced, no extra psubscribe; the old handler is no longer called
    const second: string[] = [];
    B.bus.startThreadCommandWatch((id) => second.push(id));
    subB.emit('pmessage', 'itest:thread-cmd:*', 'itest:thread-cmd:t7', 'other');
    expect(aborted).toEqual(['t9']);
    expect(second).toEqual(['t7']);
    expect(subB.callsOf('psubscribe')).toHaveLength(1);
  });

  it('threadRunRemote:EXISTS>0 → true;0 → false;探测报错 → false', async () => {
    const { bus } = await freshReplica();
    await expect(bus.threadRunRemote('t1')).resolves.toBe(false); // default exists → 0
    const redis = FakeRedis.all[0]!; // getPub lazily built
    expect(redis.callsOf('exists')[0]).toEqual(['itest:thread-run:t1']);
    redis.results.exists = 1;
    await expect(bus.threadRunRemote('t1')).resolves.toBe(true);
    redis.results.exists = new Error('down');
    await expect(bus.threadRunRemote('t1')).resolves.toBe(false);
  });

  it('seq 分配/高水位:INCR 键名 itest:thread-seq:<id>;高水位 GET 同键;删除 DEL;报错落本地兜底', async () => {
    const { bus } = await freshReplica();
    await expect(bus.allocateThreadSeq('t1')).resolves.toBe(0); // first call lazily builds; fake default incr → 0
    const redis = FakeRedis.all[0]!;
    // Real INCR's monotonicity is guaranteed by Redis; the fake only verifies key name and value passthrough (the cold-build baseline reads the same key)
    redis.results.incr = 41;
    await expect(bus.allocateThreadSeq('t1')).resolves.toBe(41);
    expect(redis.callsOf('incr')[0]).toEqual(['itest:thread-seq:t1']);
    redis.results.get = 41;
    await expect(bus.currentThreadSeq('t1')).resolves.toBe(41);
    expect(redis.callsOf('get')[0]).toEqual(['itest:thread-seq:t1']);
    redis.results.get = 0; // missing key/bad value → 0
    await expect(bus.currentThreadSeq('t1')).resolves.toBe(0);

    bus.deleteThreadSeq('t1');
    expect(redis.callsOf('del')[0]).toEqual(['itest:thread-seq:t1']);

    // Redis failure degradation: the local fallback counter takes over (cross-replica consistency is lost; single-process semantics unchanged)
    redis.results.incr = new Error('down');
    redis.results.get = new Error('down');
    await expect(bus.allocateThreadSeq('t2')).resolves.toBe(1);
    await expect(bus.allocateThreadSeq('t2')).resolves.toBe(2);
    await expect(bus.currentThreadSeq('t2')).resolves.toBe(2);
  });
});
