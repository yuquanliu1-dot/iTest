import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'nqh12UCAW+ZhepC+gqL/n1phEn5mo+xq82Key67ePXI=';
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { plansRoute } = await import('../src/routes/plans.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(userId, username, orgId, orgPath);
    next();
  });
  app.use('/api/plans', plansRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

/** 建产品线，并把给定项目挂进去。 */
async function seedProductLine(name: string, projectIds: string[]): Promise<string> {
  const { orgId } = await seedOrg(pool);
  const line = await pool.query(`INSERT INTO product_lines(organization_id, name) VALUES ($1, $2) RETURNING id`, [orgId, name]);
  const lineId = line.rows[0]!.id as string;
  for (const pid of projectIds) {
    await pool.query(`UPDATE projects SET product_line_id = $1 WHERE id = $2`, [lineId, pid]);
  }
  return lineId;
}

/** 在指定项目里造一个用例。 */
async function seedCase(projectId: string, groupId: string, versionId: string, title: string): Promise<string> {
  const r = await pool.query(
    `INSERT INTO test_cases(group_id, version_id, title) VALUES ($1, $2, $3) RETURNING id`,
    [groupId, versionId, title],
  );
  void projectId;
  return r.rows[0]!.id as string;
}

/** 在指定项目里造一个计划。 */
async function seedPlan(projectId: string, versionId: string, name: string): Promise<string> {
  const r = await pool.query(
    `INSERT INTO execution_plans(project_id, version_id, name) VALUES ($1, $2, $3) RETURNING id`,
    [projectId, versionId, name],
  );
  return r.rows[0]!.id as string;
}

describe('计划跨项目用例（产品线）', () => {
  it('同产品线的兄弟项目用例可以加入计划', async () => {
    const baseline = await seedProject(pool);
    const site = await seedProject(pool);
    await seedProductLine('同线', [baseline.projectId, site.projectId]);

    const baselineCase = await seedCase(baseline.projectId, baseline.groupId, baseline.versionId, '基线登录');
    const siteCase = await seedCase(site.projectId, site.groupId, site.versionId, '局点巡检');
    const planId = await seedPlan(site.projectId, site.versionId, '局点A回归');

    const r = await request(app)
      .put(`/api/plans/${planId}/cases`)
      .send({ caseIds: [baselineCase, siteCase] });
    expect(r.status).toBe(200);

    const detail = await request(app).get(`/api/plans/${planId}`);
    expect(detail.status).toBe(200);
    const ids = detail.body.cases.map((c: { id: string }) => c.id);
    expect(ids).toContain(baselineCase);
    expect(ids).toContain(siteCase);
  });

  it('跨产品线的用例被拒（409 cross_project）', async () => {
    const lineA = await seedProject(pool);
    const lineB = await seedProject(pool);
    await seedProductLine('线A', [lineA.projectId]);
    await seedProductLine('线B', [lineB.projectId]);

    const foreignCase = await seedCase(lineB.projectId, lineB.groupId, lineB.versionId, '他线用例');
    const planId = await seedPlan(lineA.projectId, lineA.versionId, '线A计划');

    const r = await request(app)
      .put(`/api/plans/${planId}/cases`)
      .send({ caseIds: [foreignCase] });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('cross_project');
  });

  it('同一条线内的两个项目可互相引用用例', async () => {
    const a = await seedProject(pool);
    const b = await seedProject(pool);
    // seedProject 默认把两个项目挂到同一条种子线（同线才允许跨项目引用），无需另建线。
    const bCase = await seedCase(b.projectId, b.groupId, b.versionId, '别项目用例');
    const planId = await seedPlan(a.projectId, a.versionId, '同线计划');

    const r = await request(app)
      .put(`/api/plans/${planId}/cases`)
      .send({ caseIds: [bCase] });
    expect(r.status).toBe(200);
  });

  it('项目移出产品线后，跨项目用例重新被拒', async () => {
    const baseline = await seedProject(pool);
    const site = await seedProject(pool);
    await seedProductLine('待解绑', [baseline.projectId, site.projectId]);
    // 换一个同组织的新线，把基线项目挪进去 —— 两者从此不同线。
    const otherLineId = await seedProductLine('另一条线', []);

    const baselineCase = await seedCase(baseline.projectId, baseline.groupId, baseline.versionId, '基线用例');
    const planId = await seedPlan(site.projectId, site.versionId, '解绑前计划');

    const before = await request(app).put(`/api/plans/${planId}/cases`).send({ caseIds: [baselineCase] });
    expect(before.status).toBe(200);

    // R2：product_line_id 必填，不存在「未归线」——脱离当前线的唯一方式是换到另一条线。
    // 测试意图（同线才可跨项目引用）不变：换线后两者不同线，跨项目用例重新被拒。
    await pool.query(`UPDATE projects SET product_line_id = $1 WHERE id = $2`, [otherLineId, baseline.projectId]);

    const after = await request(app).put(`/api/plans/${planId}/cases`).send({ caseIds: [baselineCase] });
    expect(after.status).toBe(409);
    expect(after.body.error).toBe('cross_project');
  });

  it('getPlanDetail 为跨项目用例回带 projectId/projectName', async () => {
    const baseline = await seedProject(pool);
    const site = await seedProject(pool);
    await seedProductLine('回带', [baseline.projectId, site.projectId]);
    await pool.query(`UPDATE projects SET name = '基线项目' WHERE id = $1`, [baseline.projectId]);

    const baselineCase = await seedCase(baseline.projectId, baseline.groupId, baseline.versionId, '基线用例');
    const planId = await seedPlan(site.projectId, site.versionId, '回带计划');
    await request(app).put(`/api/plans/${planId}/cases`).send({ caseIds: [baselineCase] });

    const detail = await request(app).get(`/api/plans/${planId}`);
    const c = detail.body.cases.find((x: { id: string }) => x.id === baselineCase);
    expect(c.projectId).toBe(baseline.projectId);
    expect(c.projectName).toBe('基线项目');
  });

  it('getPlanDetail 为跨版本用例回带 versionName', async () => {
    const baseline = await seedProject(pool);
    const site = await seedProject(pool);
    await seedProductLine('版本回带', [baseline.projectId, site.projectId]);
    await pool.query(`UPDATE project_versions SET name = 'V2.0' WHERE id = $1`, [baseline.versionId]);

    const baselineCase = await seedCase(baseline.projectId, baseline.groupId, baseline.versionId, '基线用例');
    const planId = await seedPlan(site.projectId, site.versionId, '版本回带计划');
    await request(app).put(`/api/plans/${planId}/cases`).send({ caseIds: [baselineCase] });

    const detail = await request(app).get(`/api/plans/${planId}`);
    const c = detail.body.cases.find((x: { id: string }) => x.id === baselineCase);
    expect(c.versionId).toBe(baseline.versionId);
    expect(c.versionName).toBe('V2.0');
  });

  it('删除被引用的原用例，计划的成员行随之级联消失（活引用）', async () => {
    const baseline = await seedProject(pool);
    const site = await seedProject(pool);
    await seedProductLine('活引用', [baseline.projectId, site.projectId]);

    const baselineCase = await seedCase(baseline.projectId, baseline.groupId, baseline.versionId, '将被删的用例');
    const planId = await seedPlan(site.projectId, site.versionId, '活引用计划');
    await request(app).put(`/api/plans/${planId}/cases`).send({ caseIds: [baselineCase] });

    await pool.query(`DELETE FROM test_cases WHERE id = $1`, [baselineCase]);

    const members = await pool.query(`SELECT id FROM plan_cases WHERE plan_id = $1`, [planId]);
    expect(members.rowCount).toBe(0);
  });
});