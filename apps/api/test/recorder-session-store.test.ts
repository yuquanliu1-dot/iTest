import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unit tests for the recorder session append-only store (mirrors live-view-bus.test.ts's REDIS_URL switch + vi.doMock('ioredis') technique):
 * - a stateful FakeRedis (data plane shared across connections = a simulated shared Redis) + two ws module instances (vi.resetModules)
 *   = two replicas interleave appendStep → finishSession sees the union (the old whole-record cache implementation silently dropped steps in this scenario);
 * - finishSession idempotency: fetches everything then deletes the three keys, a second finish → undefined;
 * - no REDIS_URL → in-process Map fallback, behaviorally isomorphic.
 * The tested module is only ever dynamically imported (no static import at the top; see live-view-bus.test.ts for the reason). */

/** Data plane: shared by all FakeRedis instances (= the shared Redis). */
const store = {
  strings: new Map<string, string>(),
  lists: new Map<string, string[]>(),
  ttls: new Map<string, number>(),
  reset(): void {
    this.strings.clear();
    this.lists.clear();
    this.ttls.clear();
  },
};

class FakeRedis {
  static all: FakeRedis[] = [];
  constructor() {
    FakeRedis.all.push(this);
  }
  on(_event: string, _cb: () => void): void {
    // ioredis interface surface: ws.ts attaches an error listener after connecting
  }
  async set(key: string, val: string, _mode: 'EX', ttl: number): Promise<'OK'> {
    store.strings.set(key, val);
    store.ttls.set(key, ttl);
    return 'OK';
  }
  async get(key: string): Promise<string | null> {
    return store.strings.get(key) ?? null;
  }
  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) {
      if (store.strings.delete(k)) n++;
      if (store.lists.delete(k)) n++;
      store.ttls.delete(k);
    }
    return n;
  }
  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = store.lists.get(key) ?? [];
    const from = start < 0 ? Math.max(list.length + start, 0) : start;
    const to = stop < 0 ? list.length + stop + 1 : stop + 1;
    return list.slice(from, to);
  }
  pipeline() {
    // Each pipeline() is an independent batch (ioredis semantics): exec does not replay the previous batch's ops
    const ops: Array<{ cmd: string; args: unknown[] }> = [];
    const api = {
      rpush: (key: string, ...vals: string[]) => {
        ops.push({ cmd: 'rpush', args: [key, ...vals] });
        return api;
      },
      pexpire: (key: string, ms: number) => {
        ops.push({ cmd: 'pexpire', args: [key, ms] });
        return api;
      },
      lrange: (key: string, start: number, stop: number) => {
        ops.push({ cmd: 'lrange', args: [key, start, stop] });
        return api;
      },
      exec: async () => {
        const results: Array<[null, string[] | null]> = [];
        for (const o of ops) {
          if (o.cmd === 'rpush') {
            const list = store.lists.get(o.args[0] as string) ?? [];
            list.push(...(o.args.slice(1) as string[]));
            store.lists.set(o.args[0] as string, list);
          } else if (o.cmd === 'pexpire') {
            store.ttls.set(o.args[0] as string, o.args[1] as number);
          }
          results.push([
            null,
            o.cmd === 'lrange' ? await this.lrange(o.args[0] as string, o.args[1] as number, o.args[2] as number) : null,
          ]);
        }
        return results;
      },
    };
    return api;
  }
}

type WsModule = typeof import('../src/recorder/ws.js');

/** Dynamically load a fresh ws module wired to the shared FakeRedis (= one "replica"). */
async function freshReplica(): Promise<WsModule> {
  vi.resetModules();
  vi.doMock('ioredis', () => ({ default: FakeRedis }));
  return import('../src/recorder/ws.js');
}

/** Load a fresh ws module with no Redis attached (= the no-REDIS_URL deployment shape; the ioredis constructor must not be touched then). */
async function freshLocalReplica(): Promise<WsModule> {
  vi.resetModules();
  return import('../src/recorder/ws.js');
}

afterEach(() => {
  delete process.env.REDIS_URL;
  vi.doUnmock('ioredis');
  vi.restoreAllMocks();
  store.reset();
});

describe('跨副本追加式（有状态 fake redis）', () => {
  beforeEach(() => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    store.reset();
  });

  it('两副本交错 appendStep/tab-event → finishSession 取到并集（旧整包覆盖实现丢另一副本的步骤）', async () => {
    const replicaA = await freshReplica();
    const session = replicaA.createSession('00000000-0000-0000-0000-000000000abc', { mode: 'fresh', targetUrl: 'https://x.example.com' });

    const replicaB = await freshReplica(); // another "replica" (independent module state, shared fake redis data plane)
    const hydrated = await replicaB.getSession(session.sessionId);
    expect(hydrated?.caseId).toBe('00000000-0000-0000-0000-000000000abc');
    expect(hydrated?.mode).toBe('fresh');

    await replicaA.appendStep(session.sessionId, { action: { kind: 'click', locator: [{ strategy: 'css', value: '#a' }] } });
    await replicaB.appendStep(session.sessionId, { action: { kind: 'fill', locator: [{ strategy: 'css', value: '#b' }], value: 'v' } });
    await replicaB.appendTabEvent(session.sessionId, { kind: 'opened', tabRef: `${session.sessionId}|tab#1` });

    const steps = await replicaA.getSessionSteps(session.sessionId);
    expect(steps).toHaveLength(2);
    expect((steps[0] as { action: { kind: string } }).action.kind).toBe('click');
    expect((steps[1] as { action: { kind: string } }).action.kind).toBe('fill');
    expect(await replicaB.getSessionTabs(session.sessionId)).toHaveLength(1);
  });

  it('appendStep 续期三键（活跃录制不中途过期）', async () => {
    const replica = await freshReplica();
    const session = replica.createSession('00000000-0000-0000-0000-000000000ttl');
    await replica.appendStep(session.sessionId, { action: { kind: 'click' } });
    const stepsKey = `itest:rec-steps:${session.sessionId}`;
    // pexpire stores milliseconds: appendStep renews the three keys → SESSION_TTL_S * 1000
    expect(store.ttls.get(stepsKey)).toBe(3600_000);
    expect(store.ttls.get(`itest:rec:${session.sessionId}`)).toBe(3600_000);
    expect(store.ttls.get(`itest:rec-tabs:${session.sessionId}`)).toBe(3600_000);
  });

  it('finishSession：meta+steps+tabs 取齐、三键删除、二次 finish → undefined', async () => {
    const replicaA = await freshReplica();
    const session = replicaA.createSession('00000000-0000-0000-0000-000000000fin', { resumeFromOrder: 2 });
    await replicaA.appendStep(session.sessionId, { action: { kind: 'navigate', url: '/x' } });
    await replicaA.appendTabEvent(session.sessionId, { kind: 'closed', tabRef: `${session.sessionId}|tab#0` });

    const replicaB = await freshReplica();
    const finished = await replicaB.finishSession(session.sessionId);
    expect(finished).toBeDefined();
    expect(finished!.meta.caseId).toBe('00000000-0000-0000-0000-000000000fin');
    expect(finished!.meta.resumeFromOrder).toBe(2);
    expect(finished!.steps).toHaveLength(1);
    expect(finished!.tabs).toHaveLength(1);
    expect(store.strings.has(`itest:rec:${session.sessionId}`)).toBe(false);
    expect(store.lists.has(`itest:rec-steps:${session.sessionId}`)).toBe(false);
    expect(store.lists.has(`itest:rec-tabs:${session.sessionId}`)).toBe(false);

    await expect(replicaB.finishSession(session.sessionId)).resolves.toBeUndefined();
    await expect(replicaB.getSession(session.sessionId)).resolves.toBeUndefined();
    await expect(replicaB.getSessionSteps(session.sessionId)).resolves.toEqual([]);
  });

  it('dbSessionId 回填经 persistSession 对其他副本可见', async () => {
    const replicaA = await freshReplica();
    const session = replicaA.createSession('00000000-0000-0000-0000-000000000db');
    session.dbSessionId = 'db-row-1';
    await replicaA.persistSession(session);

    const replicaB = await freshReplica();
    const hydrated = await replicaB.getSession(session.sessionId);
    expect(hydrated?.dbSessionId).toBe('db-row-1');
  });
});

describe('无 REDIS_URL → 进程内 Map 兜底（行为同构）', () => {
  beforeEach(() => {
    delete process.env.REDIS_URL;
  });

  it('create/append/finish 全链路不建 redis 连接；二次 finish → undefined', async () => {
    const replica = await freshLocalReplica();
    const session = replica.createSession('00000000-0000-0000-0000-000000000loc', { mode: 'append' });
    await replica.appendStep(session.sessionId, { action: { kind: 'click' } });
    await replica.appendTabEvent(session.sessionId, { kind: 'opened', tabRef: 't' });

    expect(await replica.getSessionSteps(session.sessionId)).toHaveLength(1);
    expect(await replica.getSessionTabs(session.sessionId)).toHaveLength(1);

    const finished = await replica.finishSession(session.sessionId);
    expect(finished!.steps).toHaveLength(1);
    expect(finished!.tabs).toHaveLength(1);
    expect(finished!.meta.mode).toBe('append');
    await expect(replica.finishSession(session.sessionId)).resolves.toBeUndefined();
    await expect(replica.getSessionSteps(session.sessionId)).resolves.toEqual([]);
  });
});
