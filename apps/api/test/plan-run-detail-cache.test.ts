import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';
import { __setClientForTests } from '../src/lib/cache.js';
import { planRunDetailKey } from '../src/lib/cache-keys.js';

let pool: Pool;
let app: import('express').Express;

// Minimal ioredis stub: Map storage; wrap's get/set and del all go through here (same pattern as test/cache.test.ts).
// Hoisted to module level so cases can directly check backfill/invalidation effects.
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
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'nqh12UCAW+ZhepC+gqL/n1phEn5mo+xq82Key67ePXI=';
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  __setClientForTests(fake as never);
  const { default: express } = await import('express');
  const { planRunsRoute } = await import('../src/routes/planRuns.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(userId, username, orgId, orgPath);
    next();
  });
  app.use('/api/plan-runs', planRunsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { __resetClientForTests } = await import('../src/lib/cache.js');
  __resetClientForTests();
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
});

/** Create a plan + one run + N member cases (each member with a report). */
async function seedRun(opts: { status?: string; reportCount?: number } = {}) {
  const { projectId, groupId } = await seedProject(pool);
  const plan = await pool.query(`INSERT INTO execution_plans(project_id, name) VALUES ($1, 'p') RETURNING id`, [projectId]);
  const planId = plan.rows[0]!.id as string;
  const run = await pool.query(
    `INSERT INTO plan_runs(plan_id, project_id, status, strategy) VALUES ($1, $2, $3, 'run_all') RETURNING id`,
    [planId, projectId, opts.status ?? 'passed'],
  );
  const runId = run.rows[0]!.id as string;
  const reportIds: string[] = [];
  for (let i = 0; i < (opts.reportCount ?? 2); i++) {
    const c = await pool.query(`INSERT INTO test_cases(group_id, title) VALUES ($1, $2) RETURNING id`, [groupId, `c${i}`]);
    const caseId = c.rows[0]!.id as string;
    const r = await pool.query(
      `INSERT INTO reports(case_id, status, step_results) VALUES ($1, 'passed', '[]'::jsonb) RETURNING id`,
      [caseId],
    );
    const reportId = r.rows[0]!.id as string;
    reportIds.push(reportId);
    await pool.query(
      `INSERT INTO plan_run_cases(plan_run_id, case_id, report_id, "order", status, step_kind)
       VALUES ($1, $2, $3, $4, 'passed', 'business')`,
      [runId, caseId, reportId, i],
    );
  }
  return { projectId, planId, runId, reportIds };
}

describe('plan-run detail cache', () => {
  it('终态运行缓存：库内 summary 变了，详情仍返回旧快照', async () => {
    const { runId } = await seedRun({ status: 'passed' });
    await pool.query(`UPDATE plan_runs SET summary = 'v1' WHERE id = $1`, [runId]);

    const first = await request(app).get(`/api/plan-runs/${runId}`);
    expect(first.status).toBe(200);
    expect(first.body.summary).toBe('v1');
    // The first GET has backfilled the detail into the cache
    expect(fake.store.has(planRunDetailKey(runId))).toBe(true);

    await pool.query(`UPDATE plan_runs SET summary = 'v2' WHERE id = $1`, [runId]);
    const second = await request(app).get(`/api/plan-runs/${runId}`);
    expect(second.status).toBe(200);
    expect(second.body.summary).toBe('v1'); // Cache hit, does not reflect the DB change
  });

  it('运行中的运行不缓存：每次 GET 反映库内最新值', async () => {
    const { runId } = await seedRun({ status: 'running' });
    await pool.query(`UPDATE plan_runs SET summary = 'v1' WHERE id = $1`, [runId]);

    const first = await request(app).get(`/api/plan-runs/${runId}`);
    expect(first.status).toBe(200);
    expect(first.body.summary).toBe('v1');

    await pool.query(`UPDATE plan_runs SET summary = 'v2' WHERE id = $1`, [runId]);
    const second = await request(app).get(`/api/plan-runs/${runId}`);
    expect(second.status).toBe(200);
    expect(second.body.summary).toBe('v2');
    expect(fake.store.has(planRunDetailKey(runId))).toBe(false);
  });

  it('删除终态运行后详情立即可 404（缓存显式失效，不出幽灵快照）', async () => {
    const { runId } = await seedRun({ status: 'passed' });
    const first = await request(app).get(`/api/plan-runs/${runId}`);
    expect(first.status).toBe(200);
    expect(fake.store.has(planRunDetailKey(runId))).toBe(true);

    const del = await request(app).delete(`/api/plan-runs/${runId}`);
    expect(del.status).toBe(200);
    // The delete path has already cleared the cache key
    expect(fake.store.has(planRunDetailKey(runId))).toBe(false);

    const after = await request(app).get(`/api/plan-runs/${runId}`);
    expect(after.status).toBe(404);
  });
});
