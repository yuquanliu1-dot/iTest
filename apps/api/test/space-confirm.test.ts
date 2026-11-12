import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { requestConfirmation, resolveConfirmation, pendingCountForTesting } from '../src/pi/space/confirm.js';

describe('confirm gate', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('用户确认 → promise resolve(true),pending 清空', async () => {
    const events: Record<string, unknown>[] = [];
    const p = requestConfirmation(
      { threadId: 't1', toolName: 'manage_cases', action: 'delete', summary: '删除用例「登录-正常」', risk: 'delete' },
      (e) => events.push(e),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'confirm_request', threadId: 't1', summary: '删除用例「登录-正常」', risk: 'delete' });
    const confirmId = events[0]!.confirmId as string;
    expect(confirmId).toBeTruthy();
    resolveConfirmation(confirmId, true);
    await expect(p).resolves.toBe(true);
    expect(pendingCountForTesting()).toBe(0);
    // A consumed confirmId cannot be resolved twice (the contract basis for replayed clicks → 404)
    await expect(resolveConfirmation(confirmId, true)).resolves.toBe(false);
  });

  it('用户取消 → resolve(false)', async () => {
    const events: Record<string, unknown>[] = [];
    const p = requestConfirmation(
      { threadId: 't1', toolName: 'manage_environments', action: 'set_secret', summary: '设置 db 密码(值已隐藏)', risk: 'secret' },
      (e) => events.push(e),
    );
    resolveConfirmation(events[0]!.confirmId as string, false);
    await expect(p).resolves.toBe(false);
  });

  it('5 分钟超时 → 自动 resolve(false)', async () => {
    const p = requestConfirmation(
      { threadId: 't1', toolName: 'manage_cases', action: 'delete', summary: 'x', risk: 'delete' },
      () => {},
    );
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    await expect(p).resolves.toBe(false);
    expect(pendingCountForTesting()).toBe(0);
  });

  it('未知 confirmId → resolveConfirmation 返回 false', async () => {
    await expect(resolveConfirmation('nonexistent', true)).resolves.toBe(false);
  });

  it('并发挂起互不串扰', async () => {
    const events: Record<string, unknown>[] = [];
    const pa = requestConfirmation({ threadId: 't1', toolName: 'a', action: 'delete', summary: 'a', risk: 'delete' }, () => {});
    const pb = requestConfirmation({ threadId: 't1', toolName: 'b', action: 'delete', summary: 'b', risk: 'delete' }, () => {});
    const pc = requestConfirmation({ threadId: 't2', toolName: 'c', action: 'update', summary: 'c', risk: 'update' }, (e) => events.push(e));
    expect(pendingCountForTesting()).toBe(3);
    resolveConfirmation(events[0]!.confirmId as string, true);
    await expect(pc).resolves.toBe(true);
    expect(pendingCountForTesting()).toBe(2);
    // The other two wind down via cancel; verify ids are independent of each other (accidentally triggering pc is already ruled out)
    await expect(resolveConfirmation('bogus', true)).resolves.toBe(false);
    void pa; void pb;
  });
});

// ── Cross-replica gate (with FakeRedis attached; dynamic import grabs the request/resolve pair from the same module instance) ──────────

const KEY_PREFIX = 'itest:confirm:';
const RES_PREFIX = 'itest:confirm-res:';

type WsConfirm = typeof import('../src/pi/space/confirm.js');

class FakeRedis {
  static all: FakeRedis[] = [];
  listeners: Record<string, Array<(...args: never[]) => void>> = {};
  calls: Array<{ cmd: string; args: unknown[] }> = [];
  /** Fixed return values by command name (default null). */
  results: Record<string, unknown> = {};
  /** Data plane (static): simulates a shared Redis — connections from different module instances (= different replicas) must see each other's keys. */
  static strings = new Map<string, string>();
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
  private exec(cmd: string, ...args: unknown[]): Promise<unknown> {
    this.calls.push({ cmd, args });
    return Promise.resolve(this.results[cmd] ?? null);
  }
  set(key: string, val: string, mode: 'PX', ttl: number): Promise<'OK'> {
    void this.exec('set', key, val, mode, ttl);
    FakeRedis.strings.set(key, val);
    return Promise.resolve('OK');
  }
  del(...keys: string[]): Promise<number> {
    void this.exec('del', ...keys);
    let n = 0;
    for (const k of keys) if (FakeRedis.strings.delete(k)) n++;
    return Promise.resolve(n);
  }
  getdel(key: string): Promise<string | null> {
    void this.exec('getdel', key);
    const v = FakeRedis.strings.get(key) ?? null;
    FakeRedis.strings.delete(key);
    return Promise.resolve(v);
  }
  publish(...args: unknown[]) { return this.exec('publish', ...args); }
  subscribe(...args: unknown[]) { return this.exec('subscribe', ...args); }
  unsubscribe(...args: unknown[]) { return this.exec('unsubscribe', ...args); }
  callsOf(cmd: string) {
    return this.calls.filter((c) => c.cmd === cmd);
  }
}

/** Dynamically load the confirm module with FakeRedis attached (the pending table is isolated per module instance). */
async function freshConfirm(): Promise<WsConfirm> {
  vi.resetModules();
  FakeRedis.all = [];
  FakeRedis.strings.clear();
  vi.doMock('ioredis', () => ({ default: FakeRedis }));
  return import('../src/pi/space/confirm.js');
}

describe('confirm gate 跨副本(REDIS_URL)', () => {
  beforeEach(() => {
    process.env.REDIS_URL = 'redis://localhost:6379';
  });
  afterEach(() => {
    delete process.env.REDIS_URL;
    vi.doUnmock('ioredis');
  });

  it('挂起时开跨副本门(SET 认领键 + SUBSCRIBE 答案频道);本地 resolve 关门删键', async () => {
    const mod = await freshConfirm();
    const events: Record<string, unknown>[] = [];
    const p = mod.requestConfirmation({ threadId: 't1', toolName: 'manage_cases', action: 'delete', summary: 'x', risk: 'delete' }, (e) => events.push(e));
    const cid = events[0]!.confirmId as string;
    // Connections are lazy: getPub (SET) + getSub (SUBSCRIBE), one each
    const pub = FakeRedis.all[0]!;
    const sub = FakeRedis.all[1]!;
    expect(pub.callsOf('set')[0]!.args[0]).toBe(`itest:confirm:${cid}`);
    expect(pub.callsOf('set')[0]!.args[2]).toBe('PX');
    expect(pub.callsOf('set')[0]!.args[3]).toBe(5 * 60_000);
    expect(JSON.parse(pub.callsOf('set')[0]!.args[1] as string)).toMatchObject({ type: 'confirm_request', confirmId: cid });
    expect(sub.callsOf('subscribe')[0]!.args).toEqual([`itest:confirm-res:${cid}`]);

    // Local fast-path resolve: the answer lands directly without pub/sub, and the gate closes (unsubscribe + delete claim key)
    await expect(mod.resolveConfirmation(cid, true)).resolves.toBe(true);
    await expect(p).resolves.toBe(true);
    expect(pub.callsOf('getdel')).toHaveLength(0);
    expect(sub.callsOf('unsubscribe')[0]!.args).toEqual([`itest:confirm-res:${cid}`]);
    expect(pub.callsOf('del')[0]!.args).toEqual([`itest:confirm:${cid}`]);
  });

  it('他副本 resolve:GETDEL 认领 + publish 答案;挂起副本经订阅收到后 resolve', async () => {
    // Two module instances = two replicas: B has none of A's pending table, so resolve can only go through the cross-replica gate
    const replicaA = await freshConfirm();
    const replicaB = await freshConfirm();
    const events: Record<string, unknown>[] = [];
    const p = replicaA.requestConfirmation({ threadId: 't1', toolName: 'manage_cases', action: 'delete', summary: 'x', risk: 'delete' }, (e) => events.push(e));
    const cid = events[0]!.confirmId as string;
    // A's pub/sub = all[0]/all[1]; B's pub is lazy: created on first resolve, must be fetched after the await
    const subA = FakeRedis.all[1]!;

    await expect(replicaB.resolveConfirmation(cid, true)).resolves.toBe(true);
    const pubB = FakeRedis.all[2]!;
    expect(pubB.callsOf('getdel')[0]!.args).toEqual([`itest:confirm:${cid}`]);
    expect(pubB.callsOf('publish')[0]!.args).toEqual([`itest:confirm-res:${cid}`, '1']);
    // FakeRedis instances are not interconnected: manually dispatch the publish back to A's subscription connection (= the suspended replica receives the answer)
    subA.emit('message', `itest:confirm-res:${cid}`, '1');
    await expect(p).resolves.toBe(true);
    // Unsubscribe accounting after the answer is consumed
    expect(subA.callsOf('unsubscribe')[0]!.args).toEqual([`itest:confirm-res:${cid}`]);
  });

  it('取消路径:答案 0 → resolve(false);认领键不在他副本 → GETDEL miss → false', async () => {
    vi.useFakeTimers();
    try {
      const replicaA = await freshConfirm();
      const replicaB = await freshConfirm();
      const events: Record<string, unknown>[] = [];
      const p = replicaA.requestConfirmation({ threadId: 't1', toolName: 'manage_cases', action: 'delete', summary: 'x', risk: 'delete' }, (e) => events.push(e));
      const cid = events[0]!.confirmId as string;
      const subA = FakeRedis.all[1]!;
      subA.emit('message', `itest:confirm-res:${cid}`, '0');
      await expect(p).resolves.toBe(false);

      // Forge a confirmation (the other replica has no matching claim key): GETDEL miss → false (404 semantics)
      await expect(replicaB.resolveConfirmation(crypto.randomUUID(), true)).resolves.toBe(false);
      // Timeout path: gate closes + resolve(false); afterwards the other replica misses the same way
      const p2 = replicaA.requestConfirmation({ threadId: 't1', toolName: 'manage_cases', action: 'delete', summary: 'y', risk: 'delete' }, () => {});
      // A's pub connection is a module-level singleton (all[0]): the second suspension's SET is that connection's 2nd set
      const cid2 = (FakeRedis.all[0]!.callsOf('set')[1]!.args[0] as string).slice(KEY_PREFIX.length);
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
      await expect(p2).resolves.toBe(false);
      await expect(replicaB.resolveConfirmation(cid2, true)).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
