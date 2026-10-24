import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject, seedOrg, resetSeedOrgCache } from './helpers/db.js';
import { parseLsRemoteRefs } from '../src/services/gitProvider.js';

// 只 mock 网络探测两个入口；parseLsRemoteRefs 等纯函数经 importOriginal 保真（下方单测直接复用）。
const { listRefsMock, verifyRefMock } = vi.hoisted(() => ({
  listRefsMock: vi.fn(),
  verifyRefMock: vi.fn(),
}));
vi.mock('../src/services/gitProvider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/gitProvider.js')>();
  return { ...actual, listRefs: listRefsMock, verifyRef: verifyRefMock };
});

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;
let userId: string;
let username: string;
let orgId: string;
let orgPath: string;
let projectId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { projectVersionsRoute } = await import('../src/routes/projectVersions.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const org = await seedOrg(pool);
  userId = org.userId;
  username = org.username;
  orgId = org.orgId;
  orgPath = org.orgPath;
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(userId, username, orgId, orgPath);
    next();
  });
  app.use('/api', projectVersionsRoute);
  app.use(errorHandler);
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE projects, project_versions, "groups", test_cases, test_environments, execution_plans, project_assignments, organizations, users CASCADE`);
  resetSeedOrgCache(pool);
  // 重建缓存的种子组织（TRUNCATE 后 org 被删，注入身份里的 orgId 已无效）
  const org = await seedOrg(pool);
  userId = org.userId;
  username = org.username;
  orgId = org.orgId;
  orgPath = org.orgPath;
  const s = await seedProject(pool);
  projectId = s.projectId;
}, 30_000);

describe('project versions', () => {
  it('GET /projects/:id/versions 列出 v0', async () => {
    const r = await request(app).get(`/api/projects/${projectId}/versions`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0].name).toBe('v0');
  });

  it('POST /projects/:id/versions 新建并返回 201', async () => {
    const r = await request(app)
      .post(`/api/projects/${projectId}/versions`)
      .send({ name: 'v1.0', description: 'first release' });
    expect(r.status).toBe(201);
    expect(r.body.name).toBe('v1.0');
  });

  it('同名 version 返回 409 version_name_taken', async () => {
    const r = await request(app)
      .post(`/api/projects/${projectId}/versions`)
      .send({ name: 'v0' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('version_name_taken');
  });

  it('删除最后一个版本返回 400 last_version', async () => {
    const list = await request(app).get(`/api/projects/${projectId}/versions`);
    const r = await request(app).delete(`/api/project-versions/${list.body[0].id}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('last_version');
  });

  it('删除非空 version 返回 400 version_not_empty + 计数', async () => {
    // 先建第二个版本，否则只有一个版本会被 last_version 拦截
    await request(app)
      .post(`/api/projects/${projectId}/versions`)
      .send({ name: 'v1.0' });
    await pool.query(
      `INSERT INTO test_cases(group_id, version_id, title) VALUES ((SELECT id FROM "groups" WHERE project_id=$1), (SELECT id FROM project_versions WHERE project_id=$1 AND name='v0'), 'x')`,
      [projectId],
    );
    // 显式删除 v0（此版本的用例计数 ≥1）而非 list.body[0]——GET 列表按 created_at 排序,
    // v0/v1.0 同毫秒时会乱序,list.body[0] 可能命中空版本导致误断言（时敏 flake）
    const v0 = (await pool.query(`SELECT id FROM project_versions WHERE project_id=$1 AND name='v0'`, [projectId])).rows[0] as { id: string };
    const r = await request(app).delete(`/api/project-versions/${v0.id}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('version_not_empty');
    expect(r.body.details?.caseCount).toBeGreaterThanOrEqual(1);
  });

  it('PATCH environmentId 关联环境并随 GET 返回 environmentName', async () => {
    const env = await pool.query(
      `INSERT INTO test_environments(project_id, name) VALUES ($1, 'staging-env') RETURNING id`,
      [projectId],
    );
    const envId = env.rows[0]!.id as string;
    const cr = await request(app).post(`/api/projects/${projectId}/versions`).send({ name: 'v1.0' });
    expect(cr.status).toBe(201);
    const r = await request(app).patch(`/api/project-versions/${cr.body.id}`).send({ environmentId: envId });
    expect(r.status).toBe(200);
    expect(r.body.environmentId).toBe(envId);
    const list = await request(app).get(`/api/projects/${projectId}/versions`);
    const v = list.body.find((x: { id: string }) => x.id === cr.body.id);
    expect(v.environmentName).toBe('staging-env');
  });

  it('PATCH environmentId 跨项目环境返回 400 env_project_mismatch', async () => {
    const other = await seedProject(pool);
    const env = await pool.query(
      `INSERT INTO test_environments(project_id, name) VALUES ($1, 'other-env') RETURNING id`,
      [other.projectId],
    );
    const cr = await request(app).post(`/api/projects/${projectId}/versions`).send({ name: 'v1.0' });
    const r = await request(app).patch(`/api/project-versions/${cr.body.id}`).send({ environmentId: env.rows[0]!.id });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('env_project_mismatch');
  });

  it('PATCH environmentId null 清除关联', async () => {
    const env = await pool.query(
      `INSERT INTO test_environments(project_id, name) VALUES ($1, 'staging-env') RETURNING id`,
      [projectId],
    );
    const cr = await request(app).post(`/api/projects/${projectId}/versions`).send({ name: 'v1.0' });
    await request(app).patch(`/api/project-versions/${cr.body.id}`).send({ environmentId: env.rows[0]!.id });
    const r = await request(app).patch(`/api/project-versions/${cr.body.id}`).send({ environmentId: null });
    expect(r.status).toBe(200);
    expect(r.body.environmentId).toBeNull();
    const list = await request(app).get(`/api/projects/${projectId}/versions`);
    const v = list.body.find((x: { id: string }) => x.id === cr.body.id);
    expect(v.environmentName).toBeNull();
  });

  it('POST 带 environmentId 创建关联并随 GET 返回 environmentName', async () => {
    const env = await pool.query(
      `INSERT INTO test_environments(project_id, name) VALUES ($1, 'staging-env') RETURNING id`,
      [projectId],
    );
    const envId = env.rows[0]!.id as string;
    const r = await request(app).post(`/api/projects/${projectId}/versions`).send({ name: 'v2.0', environmentId: envId });
    expect(r.status).toBe(201);
    expect(r.body.environmentId).toBe(envId);
    const list = await request(app).get(`/api/projects/${projectId}/versions`);
    const v = list.body.find((x: { id: string }) => x.id === r.body.id);
    expect(v.environmentName).toBe('staging-env');
  });

  it('POST 缺省 environmentId → null', async () => {
    const r = await request(app).post(`/api/projects/${projectId}/versions`).send({ name: 'v2.0' });
    expect(r.status).toBe(201);
    expect(r.body.environmentId).toBeNull();
  });

  it('POST 跨项目环境返回 400 env_project_mismatch', async () => {
    const other = await seedProject(pool);
    const env = await pool.query(
      `INSERT INTO test_environments(project_id, name) VALUES ($1, 'other-env') RETURNING id`,
      [other.projectId],
    );
    const r = await request(app)
      .post(`/api/projects/${projectId}/versions`)
      .send({ name: 'v2.0', environmentId: env.rows[0]!.id });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('env_project_mismatch');
  });
});

describe('refs 列举与 ref 校验（2026-10-24 gitlab 下拉恒空 + 无测试入口）', () => {
  beforeEach(async () => {
    listRefsMock.mockReset();
    verifyRefMock.mockReset();
    await pool.query(
      `UPDATE projects SET repo_url=$1, provider='gitlab', pat_override=$2 WHERE id=$3`,
      ['https://gitlab.example.com/EDR/jwagent-ui.git', 'stored-pat-xyz', projectId],
    );
  });

  it('GET /refs 把库中已存 PAT 透传给 listRefs 并返回列表', async () => {
    listRefsMock.mockResolvedValueOnce(['master', 'feat/x']);
    const r = await request(app).get(`/api/projects/${projectId}/refs?kind=branch`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ kind: 'branch', refs: ['master', 'feat/x'] });
    expect(listRefsMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoUrl: 'https://gitlab.example.com/EDR/jwagent-ui.git', provider: 'gitlab', pat: 'stored-pat-xyz', kind: 'branch' }),
    );
  });

  it('GET /refs listRefs 抛错 → 400，message 直达 UI 手动输入分支', async () => {
    listRefsMock.mockRejectedValueOnce(new Error('连接超时：GitLab 服务 20s 内无响应'));
    const r = await request(app).get(`/api/projects/${projectId}/refs?kind=tag`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('refs_list_failed');
    expect(r.body.message).toBe('连接超时：GitLab 服务 20s 内无响应');
  });

  it('POST /verify-ref 透传 ref/kind + 已存 PAT，存在 → 200 valid:true', async () => {
    verifyRefMock.mockResolvedValueOnce({ valid: true });
    const r = await request(app).post(`/api/projects/${projectId}/verify-ref`).send({ ref: 'v2.0.6', kind: 'tag' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ valid: true });
    expect(verifyRefMock).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'v2.0.6', kind: 'tag', pat: 'stored-pat-xyz' }),
    );
  });

  it('POST /verify-ref ref 不存在也 200（valid:false + 原因）', async () => {
    verifyRefMock.mockResolvedValueOnce({ valid: false, error: '远端不存在标签 v9.9.9' });
    const r = await request(app).post(`/api/projects/${projectId}/verify-ref`).send({ ref: 'v9.9.9', kind: 'tag' });
    expect(r.status).toBe(200);
    expect(r.body.valid).toBe(false);
    expect(r.body.error).toBe('远端不存在标签 v9.9.9');
  });

  it('POST /verify-ref 探测抛错 → 400 {valid:false,error}', async () => {
    verifyRefMock.mockRejectedValueOnce(new Error('认证失败：私有仓库须配置有效 PAT'));
    const r = await request(app).post(`/api/projects/${projectId}/verify-ref`).send({ ref: 'main', kind: 'branch' });
    expect(r.status).toBe(400);
    expect(r.body.valid).toBe(false);
    expect(r.body.error).toBe('认证失败：私有仓库须配置有效 PAT');
  });

  it('POST /verify-ref 未配置仓库 → 400 no_repo', async () => {
    // seedProject 不配 repo_url；refs describe 的 beforeEach 只给外层 projectId 那个项目配了仓库
    const other = await seedProject(pool);
    const r = await request(app).post(`/api/projects/${other.projectId}/verify-ref`).send({ ref: 'main', kind: 'branch' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('no_repo');
  });
});

describe('parseLsRemoteRefs', () => {
  it('branch：剥 refs/heads/ 前缀，跳过无 tab 杂行与 ^{} 行', () => {
    const out = 'aaaa\trefs/heads/main\nbbbb\trefs/heads/feat/x\nHEAD\ncccc\trefs/heads/main^{}';
    expect(parseLsRemoteRefs(out, 'branch')).toEqual(['main', 'feat/x']);
  });

  it('tag：跳过 ^{} 解引用行（annotated tag 双行），不串到 branch', () => {
    const out = '1111\trefs/tags/v2.0.6\n2222\trefs/tags/v2.0.6^{}\n3333\trefs/heads/master';
    expect(parseLsRemoteRefs(out, 'tag')).toEqual(['v2.0.6']);
  });
});