import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { casesRoute } = await import('../src/routes/cases.js');
  const { stepsRoute } = await import('../src/routes/steps.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  // Inject the seeded org manager identity (skipping real login; visibility judgment depends on the managerOrgPaths subtree).
  // helpers/auth depends on the src service chain (which loads the db client along the way), so it must be dynamically imported only after DATABASE_URL points at the test container.
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

    // Same-project target group: the binding travels with the copy
    const sameProject = await request(app).post(`/api/cases/${src.id}/copy`).send({ targetGroupId: a.groupId });
    expect(sameProject.status).toBe(200);
    expect(sameProject.body.datasetId).toBe(ds.rows[0].id);

    // Cross-project target group: the dataset isn't carried out; set to null (fall back to one-shot execution)
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

    // Same-project target group: binding + row selection carried together
    const sameProject = await request(app).post(`/api/cases/${src.id}/copy`).send({ targetGroupId: a.groupId });
    expect(sameProject.status).toBe(200);
    expect(sameProject.body.datasetId).toBe(ds.rows[0].id);
    expect(sameProject.body.datasetRowIndexes).toEqual([1]);

    // Cross-project target group: the dataset isn't carried out, and row selection is dropped along with it
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

    // Same-project copy: semantic fields travel with the copy
    const same = await request(app).post(`/api/cases/${src.id}/copy`).send({ targetGroupId: a.groupId });
    expect(same.status).toBe(200);
    expect(same.body.expectedOutcome).toBe('登录后看到欢迎语');
    expect(same.body.windowStrategy).toBe('custom');
    expect(same.body.windowWidth).toBe(1280);
    expect(same.body.windowHeight).toBe(720);
    expect(same.body.incognito).toBe(true);
    // The requirement number is a descriptive attribute of the case itself and travels with the copy
    expect(same.body.requirementNo).toBe('REQ-2024-001');

    // Cross-project copy: environment-class bindings aren't carried out (otherwise the copy would point at another project's environment and execution would report "environment/project mismatch")
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
    // When validation fails, c1 still exists (not mistakenly deleted)
    const list = await request(app).get(`/api/cases?groupId=${groupId}`);
    expect(list.body).toHaveLength(1);
  });

  it('POST /api/cases/batch-delete rejects empty list with 400', async () => {
    const r = await request(app).post('/api/cases/batch-delete').send({ caseIds: [] });
    expect(r.status).toBe(400);
  });
});
