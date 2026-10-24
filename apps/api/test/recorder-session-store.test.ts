import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * recorder 会话追加式存储单测（仿 live-view-bus.test.ts 的 REDIS_URL 开关 + vi.doMock('ioredis') 法）：
 * - 有状态 FakeRedis（数据面跨连接共享 = 模拟共享 Redis）+ 两个 ws 模块实例（vi.resetModules）
 *   = 两副本交错 appendStep → finishSession 见并集（旧整记录缓存实现会在此场景静默丢步骤）；
 * - finishSession 幂等：取齐即删三键，二次 finish → undefined；
 * - 无 REDIS_URL → 进程内 Map 兜底，行为同构。
 * 被测模块只走动态导入（顶部不静态 import，见 live-view-bus.test.ts 的原因说明）。 */

/** 数据面：所有 FakeRedis 实例共享（= 共享 Redis）。 */
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
    // ioredis 接口面：ws.ts 建连后挂 error 监听
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
    // 每次 pipeline() 独立批次（ioredis 语义）：exec 不重放上一批的 ops
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

/** 动态载入挂共享 FakeRedis 的全新 ws 模块（= 一「副本」）。 */
async function freshReplica(): Promise<WsModule> {
  vi.resetModules();
  vi.doMock('ioredis', () => ({ default: FakeRedis }));
  return import('../src/recorder/ws.js');
}

/** 载入不挂 Redis 的全新 ws 模块（= 无 REDIS_URL 部署形态；ioredis 构造器此时不应被触达）。 */
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

    const replicaB = await freshReplica(); // 另一「副本」（独立模块状态，共享 fake redis 数据面）
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
    // pexpire 存毫秒：appendStep 续期三键 → SESSION_TTL_S * 1000
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
