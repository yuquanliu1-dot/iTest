import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject, seedProductLineInOrg } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let managerApp: import('express').Express;
let memberApp: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: exp } = await import('express');
  const { spaceRoute } = await import('../src/pi/space/router.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  const { managerUserOf, memberUserOf } = await import('./helpers/auth.js');
  const mount = (user: ReturnType<typeof managerUserOf>) => {
    const a = exp();
    a.use(exp.json());
    a.use((req, _res, next) => { req.user = user; next(); });
    a.use('/api/assistant', spaceRoute);
    a.use(errorHandler);
    return a;
  };
  managerApp = mount(managerUserOf(userId, username, orgId, orgPath));
  memberApp = mount(memberUserOf(userId, username, orgId, orgPath));
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE assistant_trajectories`);
});

describe('R2 trajectories：表与约束', () => {
  it('插入/查询往返；partial unique——同 source_case_id 双 active 插入第二次落空，软删后可再插', async () => {
    const { projectId } = await seedProject(pool);
    const lineId = (await pool.query(`SELECT product_line_id FROM projects WHERE id=$1`, [projectId])).rows[0]!.product_line_id as string;
    const caseId = randomUUID();
    const base = `INSERT INTO assistant_trajectories (id, product_line_id, task_title, task_keywords, digest, case_title, distill_model, source_case_id)
      VALUES ($1,$2,'T','k','d','C','m',$3)
      ON CONFLICT DO NOTHING`;
    await pool.query(base, [randomUUID(), lineId, caseId]);
    await pool.query(base, [randomUUID(), lineId, caseId]); // 必须不抛
    let n = (await pool.query(`SELECT count(*)::int n FROM assistant_trajectories`)).rows[0]!;
    expect(n.n).toBe(1);
    await pool.query(`UPDATE assistant_trajectories SET status='deleted' WHERE source_case_id=$1`, [caseId]);
    await pool.query(base, [randomUUID(), lineId, caseId]); // 软删后可再插
    n = (await pool.query(`SELECT count(*)::int n FROM assistant_trajectories`)).rows[0]!;
    expect(n.n).toBe(2);
  });

  it('删除产品线级联清除轨迹', async () => {
    const org = await seedOrg(pool);
    const lineId = await seedProductLineInOrg(pool, org.orgId, `线-${randomUUID().slice(0, 8)}`);
    await pool.query(`INSERT INTO assistant_trajectories (id, product_line_id, task_title, task_keywords, digest, case_title, distill_model)
      VALUES ($1,$2,'T','k','d','C','m')`, [randomUUID(), lineId]);
    await pool.query(`DELETE FROM product_lines WHERE id=$1`, [lineId]);
    const n = (await pool.query(`SELECT count(*)::int n FROM assistant_trajectories`)).rows[0]!;
    expect(n.n).toBe(0);
  });
});
