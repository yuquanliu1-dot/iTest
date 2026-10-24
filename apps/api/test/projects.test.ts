import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject, seedProductLine } from './helpers/db.js';

// mock 真实 git 探测（不连外网）；记录入参以断言 PAT 回落。
const { verifyRepoAccessMock } = vi.hoisted(() => ({ verifyRepoAccessMock: vi.fn() }));
vi.mock('../src/services/gitProvider.js', () => ({ verifyRepoAccess: verifyRepoAccessMock }));

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;
/** 新建项目必填 productLineId：全程复用同一条种子线。 */
let lineId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { projectsRoute } = await import('../src/routes/projects.js');
  const { groupsRoute } = await import('../src/routes/groups.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  lineId = (await seedProductLine(pool)).productLineId;
  // 注入种子组织管理员身份（跳过真实登录；可见性判定依赖 managerOrgPaths 子树）。
  // helpers/auth 依赖 src 服务链（连带加载 db client），须等 DATABASE_URL 指向测试容器后再动态加载。
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(userId, username, orgId, orgPath);
    next();
  });
  app.use('/api/projects', projectsRoute);
  app.use('/api/groups', groupsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

describe('projects', () => {
  it('POST creates, GET lists with case/version/env counts', async () => {
    const created = await request(app).post('/api/projects').send({ name: 'iTest 官网', description: '官网回归', productLineId: lineId });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe('iTest 官网');
    expect(created.body.description).toBe('官网回归');

    await pool.query(`INSERT INTO "groups"(project_id, name) VALUES ($1, 'g1')`, [created.body.id]);
    const g = await pool.query(`SELECT id FROM "groups" WHERE project_id = $1`, [created.body.id]);
    await pool.query(
      `INSERT INTO test_cases(title, group_id) VALUES ('c1', $1), ('c2', $1)`,
      [g.rows[0]!.id],
    );
    await pool.query(`INSERT INTO project_versions(project_id, name) VALUES ($1, 'v0')`, [created.body.id]);
    await pool.query(`INSERT INTO test_environments(project_id, name) VALUES ($1, 'staging')`, [created.body.id]);

    const list = await request(app).get('/api/projects');
    const mine = list.body.find((p: { id: string }) => p.id === created.body.id);
    expect(mine.caseCount).toBe(2);
    expect(mine.versionCount).toBe(1);
    expect(mine.environmentCount).toBe(1);
  });

  it('PATCH renames and updates description', async () => {
    const created = await request(app).post('/api/projects').send({ name: 'P', productLineId: lineId });
    const r = await request(app).patch(`/api/projects/${created.body.id}`).send({ name: 'P2', description: '新描述' });
    expect(r.body.name).toBe('P2');
    expect(r.body.description).toBe('新描述');
  });

  it('DELETE rejects non-empty project with 409', async () => {
    const { projectId, groupId } = await seedProject(pool);
    await pool.query(`INSERT INTO test_cases(title, group_id) VALUES ('x', $1)`, [groupId]);
    const r = await request(app).delete(`/api/projects/${projectId}`);
    expect(r.status).toBe(409);
  });

  it('DELETE removes project with empty groups', async () => {
    const { projectId } = await seedProject(pool);
    const r = await request(app).delete(`/api/projects/${projectId}`);
    expect(r.status).toBe(200);
  });

  it('DELETE removes empty project', async () => {
    const created = await request(app).post('/api/projects').send({ name: 'empty', productLineId: lineId });
    const r = await request(app).delete(`/api/projects/${created.body.id}`);
    expect(r.status).toBe(200);
  });

  it('缺 productLineId 被拒（400）', async () => {
    const r = await request(app).post('/api/projects').send({ name: '无线' });
    expect(r.status).toBe(400);
  });

  it('项目组织由产品线推导（不是调用者激活组织）', async () => {
    // 造一条「兄弟组织」下的线：path 挂在种子组织下 → 可见；再让项目挂到它名下
    const { orgPath } = await seedOrg(pool);
    const sub = await pool.query(
      `INSERT INTO organizations(name, path) VALUES ($1, $2) RETURNING id`,
      [`线归属组织-${Date.now()}`, `${orgPath}sub-${Date.now()}/`],
    );
    const subOrgId = sub.rows[0]!.id as string;
    const line = await pool.query(`INSERT INTO product_lines(organization_id, name) VALUES ($1, $2) RETURNING id`, [
      subOrgId,
      `子组织线-${Date.now()}`,
    ]);
    const created = await request(app)
      .post('/api/projects')
      .send({ name: '跨组织线项目', productLineId: line.rows[0]!.id });
    expect(created.status).toBe(201);
    // R2：projects 已无 organization_id —— 组织只能经产品线推导。
    // 断言两件事：项目挂在了那条线上，且响应里的 organizationId 是该线所属的子组织。
    const row = await pool.query(
      `SELECT p.product_line_id, l.organization_id FROM projects p
         JOIN product_lines l ON l.id = p.product_line_id WHERE p.id = $1`,
      [created.body.id],
    );
    expect(row.rows[0]!.product_line_id).toBe(line.rows[0]!.id);
    expect(row.rows[0]!.organization_id).toBe(subOrgId);
    expect(created.body.organizationId).toBe(subOrgId);
  });

  it('挂到他组织不可见的产品线被拒（404）', async () => {
    const foreign = await pool.query(
      `INSERT INTO organizations(name, path) VALUES ($1, $2) RETURNING id`,
      [`外部-${Date.now()}`, `/ext-${Date.now()}/`],
    );
    const line = await pool.query(`INSERT INTO product_lines(organization_id, name) VALUES ($1, $2) RETURNING id`, [
      foreign.rows[0]!.id,
      `外部线-${Date.now()}`,
    ]);
    const r = await request(app).post('/api/projects').send({ name: 'x', productLineId: line.rows[0]!.id });
    expect(r.status).toBe(404);
  });
});

describe('groups', () => {
  it('POST/GET groups under project with caseCount', async () => {
    const p = await request(app).post('/api/projects').send({ name: 'GP', productLineId: lineId });
    const g = await request(app).post(`/api/projects/${p.body.id}/groups`).send({ name: '登录与账号' });
    expect(g.status).toBe(200);
    await pool.query(`INSERT INTO test_cases(title, group_id) VALUES ('c', $1)`, [g.body.id]);
    const list = await request(app).get(`/api/projects/${p.body.id}/groups`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].caseCount).toBe(1);
  });

  it('DELETE rejects group with cases', async () => {
    const { groupId } = await seedProject(pool);
    await pool.query(`INSERT INTO test_cases(title, group_id) VALUES ('c', $1)`, [groupId]);
    const r = await request(app).delete(`/api/groups/${groupId}`);
    expect(r.status).toBe(409);
  });
});

describe('project stats', () => {
  it('returns counts and per-group breakdown', async () => {
    const p = await request(app).post('/api/projects').send({ name: 'S', productLineId: lineId });
    const g = await request(app).post(`/api/projects/${p.body.id}/groups`).send({ name: 'g' });
    await pool.query(`INSERT INTO test_cases(title, group_id) VALUES ('a', $1), ('b', $1)`, [g.body.id]);
    const r = await request(app).get(`/api/projects/${p.body.id}/stats`);
    expect(r.status).toBe(200);
    expect(r.body.cases).toBe(2);
    expect(r.body.groups).toHaveLength(1);
    expect(r.body.groups[0].caseCount).toBe(2);
  });
});

describe('verify-repo PAT 回落（2026-10-24 base-all 假报认证失败）', () => {
  it('表单 PAT 为空 + projectId：回落库中已存 PAT 探测', async () => {
    const p = await request(app)
      .post('/api/projects')
      .send({ name: 'PR-1', productLineId: lineId, repoUrl: 'https://gitlab.example.com/g/x.git', provider: 'gitlab', patOverride: 'stored-pat-123' });
    expect(p.status).toBe(201);
    verifyRepoAccessMock.mockResolvedValueOnce({ valid: true, defaultBranch: 'master' });
    const r = await request(app)
      .post('/api/projects/verify-repo')
      .send({ repoUrl: 'https://gitlab.example.com/g/x.git', provider: 'gitlab', projectId: p.body.id });
    expect(r.status).toBe(200);
    expect(r.body.valid).toBe(true);
    expect(verifyRepoAccessMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoUrl: 'https://gitlab.example.com/g/x.git', provider: 'gitlab', pat: 'stored-pat-123' }),
    );
  });

  it('表单带 PAT：用表单值，不查库', async () => {
    verifyRepoAccessMock.mockClear();
    verifyRepoAccessMock.mockResolvedValueOnce({ valid: true });
    const r = await request(app)
      .post('/api/projects/verify-repo')
      .send({ repoUrl: 'https://gitlab.example.com/g/y.git', provider: 'gitlab', patOverride: 'form-pat', projectId: '00000000-0000-0000-0000-00000000d001' });
    expect(r.status).toBe(200);
    expect(verifyRepoAccessMock).toHaveBeenCalledWith(expect.objectContaining({ pat: 'form-pat' }));
    expect(verifyRepoAccessMock).toHaveBeenCalledTimes(1);
  });

  it('无 projectId 且无 PAT：pat undefined（新建场景旧行为）', async () => {
    verifyRepoAccessMock.mockResolvedValueOnce({ valid: false, error: '认证失败' });
    const r = await request(app)
      .post('/api/projects/verify-repo')
      .send({ repoUrl: 'https://gitlab.example.com/g/z.git', provider: 'gitlab' });
    expect(r.status).toBe(200);
    expect(r.body.valid).toBe(false);
    expect(verifyRepoAccessMock).toHaveBeenCalledWith(expect.objectContaining({ pat: undefined }));
  });
});