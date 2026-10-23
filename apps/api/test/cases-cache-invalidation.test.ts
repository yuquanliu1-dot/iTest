/**
 * cases 列表缓存失效网验证：注入 fake redis 让 ?projectId= 分支真走缓存，
 * 证明 (1) 列表被回填且后续读命中（库内直改不反映）；(2) 步骤写路径（steps DELETE）
 * 的显式失效让下一次读立即拿到新数据。cases.test.ts 未注入 redis（退化直查），
 * 缓存路径只在这里覆盖。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';
import { __setClientForTests } from '../src/lib/cache.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

const fake = (() => {
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
    store,
    get: async (key: string) => {
      const e = store.get(key);
      if (!e) return null;
      if (e.expiresAt && e.expiresAt < Date.now()) {
        store.delete(key);
        return null;
      }
      return e.value;
    },
    set: async (key: string, v: string, _mode: 'PX', ttl: number) => {
      store.set(key, { value: v, expiresAt: Date.now() + ttl });
      return 'OK' as const;
    },
    del: async (...keys: string[]) => {
      let n = 0;
      for (const k of keys) if (store.delete(k)) n++;
      return n;
    },
    disconnect: () => {},
    on: () => {},
    connect: async () => {},
    ping: async () => 'PONG',
  };
})();

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  __setClientForTests(fake as never);
  const { default: express } = await import('express');
  const { casesRoute } = await import('../src/routes/cases.js');
  const { stepsRoute } = await import('../src/routes/steps.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(userId, username, orgId, orgPath);
    next();
  });
  app.use('/api/cases', casesRoute);
  app.use('/api/cases', stepsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { __resetClientForTests } = await import('../src/lib/cache.js');
  __resetClientForTests();
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

describe('cases list cache invalidation', () => {
  it('列表命中缓存（库内直改不反映）；步骤删除后失效生效立见新数据', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: '缓存用例', groupId, versionId });
    const caseId = c.body.id as string;
    const stepRes = await request(app).post(`/api/cases/${caseId}/steps`).send({
      steps: [
        { order: 1, source: 'agent', compiled: [{ kind: 'navigate', url: 'https://example.com' }] },
        { order: 2, source: 'agent', compiled: [{ kind: 'click', locator: [{ strategy: 'role', value: 'button[name="登录"]' }] }] },
      ],
    });
    expect(stepRes.status).toBe(200);
    const ids = (stepRes.body.steps as Array<{ id: string }>).map((s) => s.id);

    const list = (await request(app).get(`/api/cases?projectId=${projectId}`)).body as Array<{ id: string; stepsTotal: number; stepsCompiled: number }>;
    const row = list.find((r) => r.id === caseId)!;
    expect(row.stepsTotal).toBe(2);
    expect(row.stepsCompiled).toBe(2);

    // 直改库（绕过失效网）→ 列表仍返回旧值 = 命中缓存
    await pool.query(`UPDATE test_steps SET compiled = NULL WHERE case_id = $1`, [caseId]);
    const cached = (await request(app).get(`/api/cases?projectId=${projectId}`)).body as Array<{ id: string; stepsTotal: number; stepsCompiled: number }>;
    expect(cached.find((r) => r.id === caseId)!.stepsCompiled).toBe(2);

    // 走 API 删一步（写路径显式失效）→ 下一次读立即拿到新数据
    const del = await request(app).delete(`/api/cases/${caseId}/steps/${ids[0]}`);
    expect(del.status).toBe(200);
    const fresh = (await request(app).get(`/api/cases?projectId=${projectId}`)).body as Array<{ id: string; stepsTotal: number; stepsCompiled: number }>;
    expect(fresh.find((r) => r.id === caseId)!.stepsTotal).toBe(1);
    // 库里剩余步 compiled 已被上面直改清空
    expect(fresh.find((r) => r.id === caseId)!.stepsCompiled).toBe(0);
  });
});
