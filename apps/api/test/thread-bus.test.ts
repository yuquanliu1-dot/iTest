import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * threadBus（Assistant/RCA 线程跨副本桥）单元测试。
 * 仿 space-confirm.test.ts 的 vi.doMock('ioredis') + resetModules 法：
 * - 一个模块实例 = 一个副本；freshReplica 同时动态 import redisLock.js，
 *   取同 registry 周期的 ORIGIN_ID（顶层静态 import 在 doMock 后与 threadBus
 *   内部实例不同源，不能用来构造/断言信封 origin）。
 * - FakeRedis 不互连：发布侧用 callsOf 捕获 (chan, msg)，手动 emit 回订阅侧连接
 *   （= 模拟 Redis 把消息派发给订阅副本）。
 * 运行锁（itest:thread-run）的 SET NX / Lua 原语由 redis-lock.test.ts 兜底，
 * session 层（同副本 steer 重入 / 异副本拒绝）在 space-session.test.ts。
 */

type ThreadBus = typeof import('../src/pi/space/threadBus.js');
type RedisLock = typeof import('../src/lib/redisLock.js');

class FakeRedis {
  static all: FakeRedis[] = [];
  listeners: Record<string, Array<(...args: never[]) => void>> = {};
  calls: Record<string, unknown[][]> = {};
  /** 按命令名覆写返回值（Error → reject）；缺省 0（exists→0 = 无锁，其余被 catch 吞）。 */
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

/** 动态载入一对 (threadBus, redisLock)：同一次 reset 周期 → 共享同一 ORIGIN_ID。 */
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
    expect(FakeRedis.all).toHaveLength(0); // 全程零连接
  });

  it('seq 分配/高水位:无 Redis 走进程内兜底计数,单调递增', async () => {
    const { bus } = await freshReplica();
    await expect(bus.allocateThreadSeq('t1')).resolves.toBe(1);
    await expect(bus.allocateThreadSeq('t1')).resolves.toBe(2);
    await expect(bus.currentThreadSeq('t1')).resolves.toBe(2);
    await expect(bus.currentThreadSeq('t-none')).resolves.toBe(0);
    expect(FakeRedis.all).toHaveLength(0); // 全程零连接
    bus.deleteThreadSeq('t1'); // 本地兜底同步清
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
    // B 首订阅 → SUBSCRIBE 事件频道（B 的 sub 连接 = all[0]，B 的 freshReplica 刚清空 all）
    const subB = FakeRedis.all[0]!;
    expect(subB.callsOf('subscribe')[0]).toEqual(['itest:thread-ev:t1']);

    // A 发布 → 捕获信封（A 的 pub lazy 建 = all[1]）
    A.bus.publishThreadEvent('t1', { type: 'verify_progress', seq: 1 });
    const pubA = FakeRedis.all[1]!;
    const [chan, msg] = pubA.callsOf('publish')[0]! as [string, string];
    expect(chan).toBe('itest:thread-ev:t1');
    const env = JSON.parse(msg) as { o: string; e: Record<string, unknown> };
    expect(env.o).toBe(A.lock.ORIGIN_ID);
    expect(env.e).toMatchObject({ type: 'verify_progress', seq: 1 });

    // 手动派发给 B 的订阅连接 = 挂起副本收到异源事件 → 转发
    subB.emit('message', chan, msg);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ type: 'verify_progress', seq: 1 });

    // 本副本回环:B 自己发布(信封 origin = B)→ 不转发(本地 listeners 已送达)
    B.bus.publishThreadEvent('t1', { type: 'x' });
    const pubB = FakeRedis.all[2]!;
    subB.emit('message', 'itest:thread-ev:t1', pubB.callsOf('publish')[0]![1] as string);
    expect(got).toHaveLength(1);

    // 坏 JSON 静默忽略(不拖垮分发)
    subB.emit('message', 'itest:thread-ev:t1', '{broken');
    expect(got).toHaveLength(1);

    // 退订 → UNSUBSCRIBE 记账
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
    u2(); // 幂等:再调不重复退订
    expect(sub.callsOf('unsubscribe')).toHaveLength(1);
  });

  it('cancel 命令:异源派发给 handler,本副本回环跳过;重复 watch 只换 handler 不重复 PSUBSCRIBE', async () => {
    const A = await freshReplica();
    const B = await freshReplica();
    const aborted: string[] = [];
    B.bus.startThreadCommandWatch((id) => aborted.push(id));
    const subB = FakeRedis.all[0]!;
    expect(subB.callsOf('psubscribe')[0]).toEqual(['itest:thread-cmd:*']);

    // A 发起 cancel(值 = 发起副本 ORIGIN_ID)→ B 收到异源消息 → handler 执行
    A.bus.publishThreadCancel('t9');
    const pubA = FakeRedis.all[1]!;
    const [chan, msg] = pubA.callsOf('publish')[0]! as [string, string];
    expect(chan).toBe('itest:thread-cmd:t9');
    expect(msg).toBe(A.lock.ORIGIN_ID);
    subB.emit('pmessage', 'itest:thread-cmd:*', chan, msg);
    expect(aborted).toEqual(['t9']);

    // B 自己广播的(回环;本地快路径已 abort)跳过
    B.bus.publishThreadCancel('t8');
    const pubB = FakeRedis.all[2]!;
    subB.emit('pmessage', 'itest:thread-cmd:*', 'itest:thread-cmd:t8', pubB.callsOf('publish')[0]![1] as string);
    expect(aborted).toEqual(['t9']);

    // 重复 watch:只替换 handler,不再 psubscribe;旧 handler 不再被调
    const second: string[] = [];
    B.bus.startThreadCommandWatch((id) => second.push(id));
    subB.emit('pmessage', 'itest:thread-cmd:*', 'itest:thread-cmd:t7', 'other');
    expect(aborted).toEqual(['t9']);
    expect(second).toEqual(['t7']);
    expect(subB.callsOf('psubscribe')).toHaveLength(1);
  });

  it('threadRunRemote:EXISTS>0 → true;0 → false;探测报错 → false', async () => {
    const { bus } = await freshReplica();
    await expect(bus.threadRunRemote('t1')).resolves.toBe(false); // 缺省 exists → 0
    const redis = FakeRedis.all[0]!; // getPub lazy 建
    expect(redis.callsOf('exists')[0]).toEqual(['itest:thread-run:t1']);
    redis.results.exists = 1;
    await expect(bus.threadRunRemote('t1')).resolves.toBe(true);
    redis.results.exists = new Error('down');
    await expect(bus.threadRunRemote('t1')).resolves.toBe(false);
  });

  it('seq 分配/高水位:INCR 键名 itest:thread-seq:<id>;高水位 GET 同键;删除 DEL;报错落本地兜底', async () => {
    const { bus } = await freshReplica();
    await expect(bus.allocateThreadSeq('t1')).resolves.toBe(0); // 首调 lazy 建;fake 缺省 incr → 0
    const redis = FakeRedis.all[0]!;
    // 真 INCR 的单调性由 Redis 保证,fake 只验键名与值透传(冷构建基线读同一键)
    redis.results.incr = 41;
    await expect(bus.allocateThreadSeq('t1')).resolves.toBe(41);
    expect(redis.callsOf('incr')[0]).toEqual(['itest:thread-seq:t1']);
    redis.results.get = 41;
    await expect(bus.currentThreadSeq('t1')).resolves.toBe(41);
    expect(redis.callsOf('get')[0]).toEqual(['itest:thread-seq:t1']);
    redis.results.get = 0; // 键不存在/坏值 → 0
    await expect(bus.currentThreadSeq('t1')).resolves.toBe(0);

    bus.deleteThreadSeq('t1');
    expect(redis.callsOf('del')[0]).toEqual(['itest:thread-seq:t1']);

    // Redis 故障降级:本地兜底计数接管(副本间一致性丢失,单进程语义不变)
    redis.results.incr = new Error('down');
    redis.results.get = new Error('down');
    await expect(bus.allocateThreadSeq('t2')).resolves.toBe(1);
    await expect(bus.allocateThreadSeq('t2')).resolves.toBe(2);
    await expect(bus.currentThreadSeq('t2')).resolves.toBe(2);
  });
});
