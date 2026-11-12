/**
 * cases list cache invalidation-net verification: a fake redis is injected so the ?projectId= branch really goes through the cache,
 * proving that (1) the list gets backfilled and later reads hit it (direct DB edits don't show); (2) explicit invalidation on the step
 * write path (steps DELETE) makes the next read immediately see new data. cases.test.ts injects no redis (degrades to direct queries),
 * so the cache path is covered only here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';
import { __setClientForTests } from '../src/lib/cache.js';

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
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  pool = new Pool({ connectionString: pgDb.uri });
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

    // Direct DB edit (bypassing the invalidation net) -> the list still returns the old value = cache hit
    await pool.query(`UPDATE test_steps SET compiled = NULL WHERE case_id = $1`, [caseId]);
    const cached = (await request(app).get(`/api/cases?projectId=${projectId}`)).body as Array<{ id: string; stepsTotal: number; stepsCompiled: number }>;
    expect(cached.find((r) => r.id === caseId)!.stepsCompiled).toBe(2);

    // Delete a step via the API (write path explicitly invalidates) -> the next read immediately gets fresh data
    const del = await request(app).delete(`/api/cases/${caseId}/steps/${ids[0]}`);
    expect(del.status).toBe(200);
    const fresh = (await request(app).get(`/api/cases?projectId=${projectId}`)).body as Array<{ id: string; stepsTotal: number; stepsCompiled: number }>;
    expect(fresh.find((r) => r.id === caseId)!.stepsTotal).toBe(1);
    // The remaining step in the DB had its compiled cleared by the direct edit above
    expect(fresh.find((r) => r.id === caseId)!.stepsCompiled).toBe(0);
  });
});
