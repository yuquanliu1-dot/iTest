import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { hashSync } from 'bcryptjs';
import { SCHEMA_SQL, SEED_USER_PASSWORD } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

// 组织 A（含子组织 A2）与组织 B 互相隔离
let orgA: string; let pathA: string;
let orgA2: string; let pathA2: string;
let orgB: string; let pathB: string;
let adminA: string;
let memberB: string; // B 的普通成员（非管理员）
let adminCookieA: string;
let memberCookieB: string;

let projectA: string; let groupA: string; let caseA: string;
let projectA2: string; let groupA2: string;
let projectB: string; let groupB: string; let caseB: string;
let planB: string; let planRunB: string; let reportB: string;

async function createUser(username: string, password: string) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO users(id, username, password_hash, display_name, password_updated_at) VALUES ($1, $2, $3, $4, now())`,
    [id, username, hashSync(password, 4), username],
  );
  return id;
}

function insertOrg(name: string, parentId: string | null, parentPath: string | null) {
  const id = randomUUID();
  const path = parentPath ? `${parentPath}${id}/` : `/${id}/`;
  return pool.query(`INSERT INTO organizations(id, name, parent_id, path) VALUES ($1, $2, $3, $4)`, [id, name, parentId, path]).then(() => ({ id, path }));
}

async function insertProject(orgId: string, name: string): Promise<string> {
  const id = randomUUID();
  // R2：项目无 organization_id——先在该组织下建一条线，再把项目挂上去。
  const lineId = randomUUID();
  await pool.query(`INSERT INTO product_lines(id, organization_id, name) VALUES ($1, $2, $3)`, [lineId, orgId, `线-${name}`]);
  await pool.query(`INSERT INTO projects(id, product_line_id, name) VALUES ($1, $2, $3)`, [id, lineId, name]);
  return id;
}

async function insertGroup(projectId: string, name: string): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO "groups"(id, project_id, name) VALUES ($1, $2, $3)`, [id, projectId, name]);
  return id;
}

async function insertCase(groupId: string, title: string): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO test_cases(id, group_id, title) VALUES ($1, $2, $3)`, [id, groupId, title]);
  return id;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  // helpers/auth 依赖 src 服务链（连带加载 db client），须等 DATABASE_URL 指向测试容器后再动态加载
  const { authCookie, managerUserOf, memberUserOf } = await import('./helpers/auth.js');

  ({ id: orgA, path: pathA } = await insertOrg('组织A', null, null));
  ({ id: orgA2, path: pathA2 } = await insertOrg('组织A2-子', orgA, pathA));
  ({ id: orgB, path: pathB } = await insertOrg('组织B', null, null));

  adminA = await createUser('admin-a', SEED_USER_PASSWORD);
  await pool.query(`INSERT INTO organization_members(organization_id, user_id, is_manager, is_user) VALUES ($1, $2, true, true)`, [orgA, adminA]);
  memberB = await createUser('member-b', SEED_USER_PASSWORD);
  await pool.query(`INSERT INTO organization_members(organization_id, user_id, is_manager, is_user) VALUES ($1, $2, false, true)`, [orgB, memberB]);

  // A 管理员的身份（直接铸 token，requireAuth 回查 tokenVersion 通过）
  adminCookieA = authCookie(managerUserOf(adminA, 'admin-a', orgA, pathA));
  // B 普通成员（无管理子树，仅靠 membership 可见）
  memberCookieB = authCookie(memberUserOf(memberB, 'member-b', orgB, pathB));

  projectA = await insertProject(orgA, 'A 的项目');
  groupA = await insertGroup(projectA, 'A 默认分组');
  caseA = await insertCase(groupA, 'A 的用例');
  projectA2 = await insertProject(orgA2, 'A2 子组织的项目');
  groupA2 = await insertGroup(projectA2, 'A2 默认分组');
  projectB = await insertProject(orgB, 'B 的项目');
  groupB = await insertGroup(projectB, 'B 默认分组');
  caseB = await insertCase(groupB, 'B 的用例');

  // B 项目下造 plan + planRun + report
  planB = randomUUID();
  await pool.query(
    `INSERT INTO execution_plans(id, project_id, name, strategy) VALUES ($1, $2, 'B 的计划', 'run_all')`,
    [planB, projectB],
  );
  planRunB = randomUUID();
  await pool.query(
    `INSERT INTO plan_runs(id, plan_id, project_id, status, strategy, total_cases) VALUES ($1, $2, $3, 'passed', 'run_all', 1)`,
    [planRunB, planB, projectB],
  );
  reportB = randomUUID();
  await pool.query(
    `INSERT INTO reports(id, case_id, status, step_results) VALUES ($1, $2, 'passed', '[]'::jsonb)`,
    [reportB, caseB],
  );

  const { default: express } = await import('express');
  const { projectsRoute } = await import('../src/routes/projects.js');
  const { casesRoute } = await import('../src/routes/cases.js');
  const { stepsRoute } = await import('../src/routes/steps.js');
  const { plansRoute } = await import('../src/routes/plans.js');
  const { planRunsRoute } = await import('../src/routes/planRuns.js');
  const { reportsRoute } = await import('../src/routes/reports.js');
  const { attachmentsRoute } = await import('../src/routes/attachments.js');
  const { executeRoute } = await import('../src/routes/execute.js');
  const { recorderRoute } = await import('../src/routes/recorder.js');
  const { requireAuth } = await import('../src/middleware/auth.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  app.use('/api', requireAuth);
  app.use('/api/projects', projectsRoute);
  app.use('/api/cases', casesRoute);
  app.use('/api/cases', stepsRoute);
  app.use('/api/cases', attachmentsRoute);
  app.use('/api', executeRoute);
  app.use('/api/reports', reportsRoute);
  app.use('/api/projects/:projectId/plans', plansRoute);
  app.use('/api/plans', plansRoute);
  app.use('/api/plan-runs', planRunsRoute);
  app.use('/api/recorder', recorderRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

describe('组织 A 管理员的可见范围', () => {
  it('项目列表：本组织 + 子组织，不含 B', async () => {
    const r = await request(app).get('/api/projects').set('Cookie', adminCookieA);
    expect(r.status).toBe(200);
    const ids = r.body.map((p: { id: string }) => p.id);
    expect(ids).toContain(projectA);
    expect(ids).toContain(projectA2); // 管理子树可见
    expect(ids).not.toContain(projectB);
  });

  it('B 的项目/分组/用例/计划/运行/报告全部 404', async () => {
    expect((await request(app).get(`/api/projects/${projectB}`).set('Cookie', adminCookieA)).status).toBe(404);
    expect((await request(app).get(`/api/projects/${projectB}/groups`).set('Cookie', adminCookieA)).status).toBe(404);
    expect((await request(app).get(`/api/cases/${caseB}`).set('Cookie', adminCookieA)).status).toBe(404);
    expect((await request(app).patch(`/api/cases/${caseB}`).set('Cookie', adminCookieA).send({ title: 'hack' })).status).toBe(404);
    expect((await request(app).delete(`/api/cases/${caseB}`).set('Cookie', adminCookieA)).status).toBe(404);
    expect((await request(app).post(`/api/cases/${caseB}/copy`).set('Cookie', adminCookieA).send({ targetGroupId: groupB })).status).toBe(404);
    expect((await request(app).get(`/api/plans/${planB}`).set('Cookie', adminCookieA)).status).toBe(404);
    expect((await request(app).get(`/api/plan-runs/${planRunB}`).set('Cookie', adminCookieA)).status).toBe(404);
    expect((await request(app).get(`/api/reports/${reportB}`).set('Cookie', adminCookieA)).status).toBe(404);
  });

  it('B 资源上的写/执行操作 → 404（执行在可见性检查处被拦下）', async () => {
    expect((await request(app).post(`/api/cases/${caseB}/execute`).set('Cookie', adminCookieA)).status).toBe(404);
    expect((await request(app).post(`/api/recorder/sessions`).set('Cookie', adminCookieA).send({ caseId: caseB })).status).toBe(404);
    expect((await request(app).get(`/api/cases/${caseB}/attachments`).set('Cookie', adminCookieA)).status).toBe(404);
  });

  it('计划列表（直挂载）只含可见项目的计划', async () => {
    const r = await request(app).get('/api/plans').set('Cookie', adminCookieA);
    expect(r.status).toBe(200);
    expect(r.body.some((p: { id: string }) => p.id === planB)).toBe(false);
  });

  it('报告列表（无参）不含 B 的报告', async () => {
    const r = await request(app).get('/api/reports').set('Cookie', adminCookieA);
    expect(r.status).toBe(200);
    expect(r.body.some((x: { id: string }) => x.id === reportB)).toBe(false);
  });
});

describe('组织 B 普通成员的可见范围', () => {
  it('项目列表只有 B 的项目（membership 可见，无管理子树）', async () => {
    const r = await request(app).get('/api/projects').set('Cookie', memberCookieB);
    expect(r.status).toBe(200);
    const ids = r.body.map((p: { id: string }) => p.id);
    expect(ids).toContain(projectB);
    expect(ids).not.toContain(projectA);
    expect(ids).not.toContain(projectA2);
  });

  it('A 的资源 → 404', async () => {
    expect((await request(app).get(`/api/projects/${projectA}`).set('Cookie', memberCookieB)).status).toBe(404);
    expect((await request(app).get(`/api/cases/${caseA}`).set('Cookie', memberCookieB)).status).toBe(404);
  });

  it('B 自己的用例可正常读取', async () => {
    const r = await request(app).get(`/api/cases/${caseB}`).set('Cookie', memberCookieB);
    expect(r.status).toBe(200);
    expect(r.body.title).toBe('B 的用例');
  });
});

describe('无 token 全部 401', () => {
  it('未认证请求被毯子守卫拦截', async () => {
    expect((await request(app).get('/api/projects')).status).toBe(401);
    expect((await request(app).get(`/api/cases/${caseB}`)).status).toBe(401);
  });
});
