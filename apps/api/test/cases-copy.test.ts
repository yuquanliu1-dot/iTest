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
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { casesRoute } = await import('../src/routes/cases.js');
  const { stepsRoute } = await import('../src/routes/steps.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  // 注入种子组织管理员身份（跳过真实登录；可见性判定依赖 managerOrgPaths 子树）。
  // helpers/auth 依赖 src 服务链（连带加载 db client），须等 DATABASE_URL 指向测试容器后再动态加载。
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
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

async function makeCaseWithSteps(groupId: string, versionId: string, title: string) {
  const c = await request(app).post('/api/cases').send({ title, groupId, versionId });
  await request(app).post(`/api/cases/${c.body.id}/steps`).send({
    steps: [
      { order: 1, source: 'agent', compiled: [{ kind: 'navigate', url: 'https://x.test' }] },
      { order: 2, source: 'recorder', compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#btn' }] }] },
    ],
  });
  return c.body as { id: string; title: string };
}

describe('case copy', () => {
  it('single copy clones steps and appends 副本', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const src = await makeCaseWithSteps(groupId, versionId, '创建项目');
    const r = await request(app).post(`/api/cases/${src.id}/copy`).send({ targetGroupId: groupId });
    expect(r.status).toBe(200);
    expect(r.body.title).toBe('创建项目 副本');
    const detail = await request(app).get(`/api/cases/${r.body.id}`);
    expect(detail.body.steps).toHaveLength(2);
    expect(detail.body.requirementId).toBeNull();
  });

  it('copy naming increments 副本1, 副本2', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const src = await makeCaseWithSteps(groupId, versionId, '登录');
    const c1 = await request(app).post(`/api/cases/${src.id}/copy`).send({ targetGroupId: groupId });
    const c2 = await request(app).post(`/api/cases/${src.id}/copy`).send({ targetGroupId: groupId });
    const c3 = await request(app).post(`/api/cases/${src.id}/copy`).send({ targetGroupId: groupId });
    expect(c1.body.title).toBe('登录 副本');
    expect(c2.body.title).toBe('登录 副本1');
    expect(c3.body.title).toBe('登录 副本2');
  });

  it('copy carries datasetId within same project; drops it cross-project', async () => {
    const a = await seedProject(pool);
    const b = await seedProject(pool);
    const ds = await pool.query(
      `INSERT INTO datasets(project_id, name, columns, rows) VALUES ($1, '复制绑定', $2::jsonb, $3::jsonb) RETURNING id`,
      [
        a.projectId,
        JSON.stringify([{ name: 'u', sensitive: false }]),
        JSON.stringify([{ disabled: false, cells: { u: 'x' } }]),
      ],
    );
    const src = await makeCaseWithSteps(a.groupId, a.versionId, '绑数据集');
    const bind = await request(app).patch(`/api/cases/${src.id}`).send({ datasetId: ds.rows[0].id });
    expect(bind.status).toBe(200);

    // 同项目目标分组：绑定随拷贝携带
    const sameProject = await request(app).post(`/api/cases/${src.id}/copy`).send({ targetGroupId: a.groupId });
    expect(sameProject.status).toBe(200);
    expect(sameProject.body.datasetId).toBe(ds.rows[0].id);

    // 跨项目目标分组：数据集不外带，置空（回退单次执行）
    const crossProject = await request(app).post(`/api/cases/${src.id}/copy`).send({ targetGroupId: b.groupId });
    expect(crossProject.status).toBe(200);
    expect(crossProject.body.datasetId).toBeNull();
  });

  it('copy carries dataset row selection within same project; drops it cross-project', async () => {
    const a = await seedProject(pool);
    const b = await seedProject(pool);
    const ds = await pool.query(
      `INSERT INTO datasets(project_id, name, columns, rows) VALUES ($1, '复制行选择', $2::jsonb, $3::jsonb) RETURNING id`,
      [
        a.projectId,
        JSON.stringify([{ name: 'u', sensitive: false }]),
        JSON.stringify([
          { disabled: false, cells: { u: 'x' } },
          { disabled: false, cells: { u: 'y' } },
        ]),
      ],
    );
    const src = await makeCaseWithSteps(a.groupId, a.versionId, '绑行选择');
    await request(app).patch(`/api/cases/${src.id}`).send({ datasetId: ds.rows[0].id });
    const sel = await request(app).patch(`/api/cases/${src.id}`).send({ datasetRowIndexes: [1] });
    expect(sel.status).toBe(200);
    expect(sel.body.datasetRowIndexes).toEqual([1]);

    // 同项目目标分组：绑定 + 行选择一并携带
    const sameProject = await request(app).post(`/api/cases/${src.id}/copy`).send({ targetGroupId: a.groupId });
    expect(sameProject.status).toBe(200);
    expect(sameProject.body.datasetId).toBe(ds.rows[0].id);
    expect(sameProject.body.datasetRowIndexes).toEqual([1]);

    // 跨项目目标分组：数据集不外带，行选择也一并丢弃
    const crossProject = await request(app).post(`/api/cases/${src.id}/copy`).send({ targetGroupId: b.groupId });
    expect(crossProject.status).toBe(200);
    expect(crossProject.body.datasetId).toBeNull();
    expect(crossProject.body.datasetRowIndexes).toEqual([]);
  });

  it('copy carries case-level semantics (expectedOutcome / window / mobile) and drops cross-project env bindings', async () => {
    const a = await seedProject(pool);
    const b = await seedProject(pool);
    const src = await makeCaseWithSteps(a.groupId, a.versionId, '语义副本');
    const patch = await request(app).patch(`/api/cases/${src.id}`).send({
      expectedOutcome: '登录后看到欢迎语',
      windowStrategy: 'custom',
      windowWidth: 1280,
      windowHeight: 720,
      incognito: true,
      requirementNo: 'REQ-2024-001',
    });
    expect(patch.status).toBe(200);

    // 同项目复制：语义字段随拷贝携带
    const same = await request(app).post(`/api/cases/${src.id}/copy`).send({ targetGroupId: a.groupId });
    expect(same.status).toBe(200);
    expect(same.body.expectedOutcome).toBe('登录后看到欢迎语');
    expect(same.body.windowStrategy).toBe('custom');
    expect(same.body.windowWidth).toBe(1280);
    expect(same.body.windowHeight).toBe(720);
    expect(same.body.incognito).toBe(true);
    // 需求编号是本条用例自身的描述性属性，随拷贝携带
    expect(same.body.requirementNo).toBe('REQ-2024-001');

    // 跨项目复制：环境类绑定不外带（否则副本指向别的项目的环境，执行期报「环境与项目不匹配」）
    const cross = await request(app).post(`/api/cases/${src.id}/copy`).send({ targetGroupId: b.groupId });
    expect(cross.status).toBe(200);
    expect(cross.body.defaultEnvId).toBeNull();
  });

  it('batch copy to another group', async () => {
    const a = await seedProject(pool);
    const b = await seedProject(pool);
    const c1 = await makeCaseWithSteps(a.groupId, a.versionId, 'A');
    const c2 = await makeCaseWithSteps(a.groupId, a.versionId, 'B');
    const r = await request(app).post('/api/cases/copy').send({ caseIds: [c1.id, c2.id], targetGroupId: b.groupId });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);
    const inB = await request(app).get(`/api/cases?groupId=${b.groupId}`);
    expect(inB.body).toHaveLength(2);
  });

  it('copy to unknown group returns 404', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const src = await makeCaseWithSteps(groupId, versionId, 'X');
    const r = await request(app)
      .post(`/api/cases/${src.id}/copy`)
      .send({ targetGroupId: '00000000-0000-0000-0000-000000000000' });
    expect(r.status).toBe(404);
  });

  it('DELETE /api/cases/:id removes case and its steps', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const src = await makeCaseWithSteps(groupId, versionId, '待删除');
    const r = await request(app).delete(`/api/cases/${src.id}`);
    expect(r.status).toBe(200);
    const detail = await request(app).get(`/api/cases/${src.id}`);
    expect(detail.status).toBe(404);
    const steps = await pool.query(`SELECT * FROM test_steps WHERE case_id = $1`, [src.id]);
    expect(steps.rows).toHaveLength(0);
  });

  it('POST /api/cases/batch-delete removes all listed cases and their steps', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c1 = await makeCaseWithSteps(groupId, versionId, '批删-1');
    const c2 = await makeCaseWithSteps(groupId, versionId, '批删-2');
    const r = await request(app).post('/api/cases/batch-delete').send({ caseIds: [c1.id, c2.id] });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);
    const list = await request(app).get(`/api/cases?groupId=${groupId}`);
    expect(list.body).toHaveLength(0);
    const steps = await pool.query(`SELECT * FROM test_steps WHERE case_id IN ($1, $2)`, [c1.id, c2.id]);
    expect(steps.rows).toHaveLength(0);
  });

  it('POST /api/cases/batch-delete rejects the whole batch when any id is missing', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c1 = await makeCaseWithSteps(groupId, versionId, '存在');
    const r = await request(app).post('/api/cases/batch-delete').send({
      caseIds: [c1.id, '00000000-0000-0000-0000-000000000000'],
    });
    expect(r.status).toBe(404);
    // 校验失败时 c1 仍然存在（未误删）
    const list = await request(app).get(`/api/cases?groupId=${groupId}`);
    expect(list.body).toHaveLength(1);
  });

  it('POST /api/cases/batch-delete rejects empty list with 400', async () => {
    const r = await request(app).post('/api/cases/batch-delete').send({ caseIds: [] });
    expect(r.status).toBe(400);
  });
});
