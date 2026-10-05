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
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { casesRoute } = await import('../src/routes/cases.js');
  const { stepsRoute } = await import('../src/routes/steps.js');
  const { attachmentsRoute } = await import('../src/routes/attachments.js');
  const { secretsRoute } = await import('../src/routes/secrets.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  app.use(express.raw({ type: 'application/octet-stream', limit: '60mb' }));
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
  app.use('/api/cases', attachmentsRoute);
  app.use('/api/cases', secretsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

describe('cases + steps', () => {
  it('POST /api/cases creates', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const r = await request(app).post('/api/cases').send({ title: '登录成功', priority: 'P1', groupId, versionId });
    expect(r.status).toBe(200);
    expect(r.body.title).toBe('登录成功');
  });

  it('GET /api/cases/:id returns case with steps', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'X', groupId, versionId });
    const r = await request(app).get(`/api/cases/${c.body.id}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.steps)).toBe(true);
    expect(r.body.steps).toEqual([]);
  });

  it('POST /api/cases/:id/steps appends', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'Y', groupId, versionId });
    const r = await request(app).post(`/api/cases/${c.body.id}/steps`).send({
      steps: [
        { order: 1, source: 'agent', action: { kind: 'navigate', url: 'https://example.com/login' } },
        { order: 2, source: 'agent', action: { kind: 'click', locator: [{ strategy: 'role', value: 'button[name="登录"]' }] } },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);
  });

  it('POST /api/cases/:id/steps validates DSL', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'Z', groupId, versionId });
    const r = await request(app).post(`/api/cases/${c.body.id}/steps`).send({
      steps: [{ order: 1, source: 'agent', action: { kind: 'click', locator: [] } }],
    });
    expect(r.status).toBe(400);
  });

  it('PUT reorder rewrites order to 1..n', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'R', groupId, versionId });
    const appended = await request(app).post(`/api/cases/${c.body.id}/steps`).send({
      steps: [1, 2, 3].map((order) => ({
        order,
        source: 'agent',
        action: { kind: 'navigate', url: `https://x.test/${order}` },
      })),
    });
    const ids = appended.body.steps.map((s: { id: string }) => s.id) as string[];
    const reversed = [...ids].reverse();
    const r = await request(app)
      .put(`/api/cases/${c.body.id}/steps/reorder`)
      .send({ stepIds: reversed });
    expect(r.status).toBe(200);
    expect(r.body.steps.map((s: { id: string }) => s.id)).toEqual(reversed);
    expect(r.body.steps.map((s: { order: number }) => s.order)).toEqual([1, 2, 3]);
  });

  it('PUT reorder rejects partial id list', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'P', groupId, versionId });
    const appended = await request(app).post(`/api/cases/${c.body.id}/steps`).send({
      steps: [1, 2].map((order) => ({
        order,
        source: 'agent',
        action: { kind: 'navigate', url: 'https://x.test' },
      })),
    });
    const ids = appended.body.steps.map((s: { id: string }) => s.id) as string[];
    const r = await request(app)
      .put(`/api/cases/${c.body.id}/steps/reorder`)
      .send({ stepIds: [ids[0]] });
    expect(r.status).toBe(400);
  });

  it('DELETE step removes it and compacts order', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'D', groupId, versionId });
    const appended = await request(app).post(`/api/cases/${c.body.id}/steps`).send({
      steps: [1, 2, 3].map((order) => ({
        order,
        source: 'agent',
        action: { kind: 'navigate', url: `https://x.test/${order}` },
      })),
    });
    const ids = appended.body.steps.map((s: { id: string }) => s.id) as string[];
    const r = await request(app).delete(`/api/cases/${c.body.id}/steps/${ids[1]}`);
    expect(r.status).toBe(200);
    const detail = await request(app).get(`/api/cases/${c.body.id}`);
    expect(detail.body.steps).toHaveLength(2);
    expect(detail.body.steps.map((s: { order: number }) => s.order)).toEqual([1, 2]);
  });

  it('DELETE unknown step returns 404', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'N', groupId, versionId });
    const r = await request(app).delete(`/api/cases/${c.body.id}/steps/00000000-0000-0000-0000-000000000000`);
    expect(r.status).toBe(404);
  });

  it('POST /api/cases rejects unknown groupId', async () => {
    const r = await request(app).post('/api/cases').send({
      title: 'X',
      groupId: '00000000-0000-0000-0000-000000000000',
    });
    expect(r.status).toBe(404);
  });

  it('GET /api/cases?groupId filters', async () => {
    const a = await seedProject(pool);
    const b = await seedProject(pool);
    await request(app).post('/api/cases').send({ title: 'in A', groupId: a.groupId, versionId: a.versionId });
    await request(app).post('/api/cases').send({ title: 'in B', groupId: b.groupId, versionId: b.versionId });
    const r = await request(app).get(`/api/cases?groupId=${a.groupId}`);
    expect(r.body).toHaveLength(1);
    expect(r.body[0].title).toBe('in A');
  });

  it('GET /api/cases?projectId filters across groups', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    await request(app).post('/api/cases').send({ title: 'p1', groupId, versionId });
    const other = await seedProject(pool);
    await request(app).post('/api/cases').send({ title: 'p2', groupId: other.groupId, versionId: other.versionId });
    const r = await request(app).get(`/api/cases?projectId=${projectId}`);
    expect(r.body).toHaveLength(1);
    expect(r.body[0].title).toBe('p1');
  });

  it('GET /api/cases/:id resolves url by chain case > group > default env', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    await pool.query(`INSERT INTO test_environments(project_id, name, is_default, base_url) VALUES ($1, '默认', true, 'https://proj.test')`, [projectId]);
    const c1 = await request(app).post('/api/cases').send({ title: 'inherit', groupId, versionId });
    const d1 = await request(app).get(`/api/cases/${c1.body.id}`);
    expect(d1.body.resolvedUrl).toBe('https://proj.test');

    await pool.query(`UPDATE "groups" SET default_url = 'https://group.test' WHERE id = $1`, [groupId]);
    const d2 = await request(app).get(`/api/cases/${c1.body.id}`);
    expect(d2.body.resolvedUrl).toBe('https://group.test');

    const c2 = await request(app).post('/api/cases').send({ title: 'own', groupId, versionId, url: 'https://case.test' });
    const d3 = await request(app).get(`/api/cases/${c2.body.id}`);
    expect(d3.body.resolvedUrl).toBe('https://case.test');
  });

  it('PATCH /api/cases/:id moves case to another group', async () => {
    const a = await seedProject(pool);
    const g2 = (await pool.query(`INSERT INTO "groups"(project_id, name) VALUES ($1, '第二分组') RETURNING id`, [a.projectId])).rows[0]!.id as string;
    const c = await request(app).post('/api/cases').send({ title: 'move', groupId: a.groupId, versionId: a.versionId });
    const r = await request(app).patch(`/api/cases/${c.body.id}`).send({ groupId: g2 });
    expect(r.status).toBe(200);
    expect(r.body.groupId).toBe(g2);
  });

  it('PATCH window_strategy=custom requires width/height', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'W', groupId, versionId });
    const r = await request(app).patch(`/api/cases/${c.body.id}`).send({ windowStrategy: 'custom' });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/windowWidth/);
  });

  it('PATCH window_strategy=custom with width/height succeeds', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'W2', groupId, versionId });
    const r = await request(app)
      .patch(`/api/cases/${c.body.id}`)
      .send({ windowStrategy: 'custom', windowWidth: 1024, windowHeight: 768 });
    expect(r.status).toBe(200);
    expect(r.body.windowStrategy).toBe('custom');
    expect(r.body.windowWidth).toBe(1024);
    expect(r.body.windowHeight).toBe(768);
  });

  it('PATCH incognito=true persists', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'W3', groupId, versionId });
    const r = await request(app).patch(`/api/cases/${c.body.id}`).send({ incognito: true });
    expect(r.status).toBe(200);
    expect(r.body.incognito).toBe(true);
  });

  it('PUT /api/cases/:id/steps replaces all steps with name/delayMs', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'R', groupId, versionId });
    await request(app).post(`/api/cases/${c.body.id}/steps`).send({
      steps: [{ order: 1, source: 'agent', action: { kind: 'navigate', url: 'https://a.com' } }],
    });
    const r = await request(app).put(`/api/cases/${c.body.id}/steps`).send({
      steps: [
        { action: { kind: 'click', locator: [{ strategy: 'text', value: 'Go' }] }, source: 'recorder', name: '点 Go', delayMs: 500 },
        { action: { kind: 'fill', locator: [{ strategy: 'css', value: '#x' }], value: 'v' }, source: 'manual' },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.steps).toHaveLength(2);
    expect(r.body.steps[0].order).toBe(1);
    expect(r.body.steps[0].name).toBe('点 Go');
    expect(r.body.steps[0].delayMs).toBe(500);
    expect(r.body.steps[1].name).toBeNull();
    const g = await request(app).get(`/api/cases/${c.body.id}`);
    expect(g.body.steps).toHaveLength(2);
  });

  it('PUT /api/cases/:id/steps allows empty array (clear all)', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'E', groupId, versionId });
    const r = await request(app).put(`/api/cases/${c.body.id}/steps`).send({ steps: [] });
    expect(r.status).toBe(200);
    expect(r.body.steps).toHaveLength(0);
  });

  it('PUT stores sensitive fill as ciphertext and never echoes plaintext', async () => {
    const { ensureKeyLoaded } = await import('../src/lib/secret-crypto.js');
    ensureKeyLoaded();
    const { groupId, versionId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'S', groupId, versionId });
    const r = await request(app).put(`/api/cases/${c.body.id}/steps`).send({
      steps: [
        {
          action: {
            kind: 'fill',
            locator: [{ strategy: 'css', value: 'input[type=password]' }],
            value: 'super-secret',
            sensitive: true,
          },
          source: 'manual',
        },
      ],
    });
    expect(r.status).toBe(200);
    const body = JSON.stringify(r.body);
    expect(body).not.toContain('super-secret');
    const got = await request(app).get(`/api/cases/${c.body.id}`);
    expect(JSON.stringify(got.body)).not.toContain('super-secret');
  });

  it('PUT rejects upload step with unknown fileId', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'U', groupId, versionId });
    const r = await request(app).put(`/api/cases/${c.body.id}/steps`).send({
      steps: [
        {
          action: { kind: 'upload', locator: [{ strategy: 'css', value: 'input[type=file]' }], fileId: 'no-such' },
          source: 'manual',
        },
      ],
    });
    expect(r.status).toBe(422);
  });

  it('PUT accepts upload step with valid fileId', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'U2', groupId, versionId });
    const buf = Buffer.from('file-body');
    const up = await request(app)
      .post(`/api/cases/${c.body.id}/attachments`)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Filename', 'x.bin')
      .send(buf);
    const r = await request(app).put(`/api/cases/${c.body.id}/steps`).send({
      steps: [
        {
          action: { kind: 'upload', locator: [{ strategy: 'css', value: 'input[type=file]' }], fileId: up.body.id },
          source: 'manual',
        },
      ],
    });
    expect(r.status).toBe(200);
  });

  it('PUT rejects upload step referencing a fileId from another project', async () => {
    // Two separate projects → two separate groups/cases
    const { groupId: gA, versionId: vA } = await seedProject(pool);
    const cA = await request(app).post('/api/cases').send({ title: 'A', groupId: gA, versionId: vA });
    const { groupId: gB, versionId: vB } = await seedProject(pool);
    const cB = await request(app).post('/api/cases').send({ title: 'B', groupId: gB, versionId: vB });
    // Upload under case A
    const up = await request(app)
      .post(`/api/cases/${cA.body.id}/attachments`)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Filename', 'a.txt')
      .send(Buffer.from('alpha'));
    const foreignFileId = up.body.id;
    // Try to bind that fileId to a step on case B (different project)
    const r = await request(app).put(`/api/cases/${cB.body.id}/steps`).send({
      steps: [
        {
          action: { kind: 'upload', locator: [{ strategy: 'css', value: 'input[type=file]' }], fileId: foreignFileId },
          source: 'manual',
        },
      ],
    });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('upload_unknown_file');
  });

  it('PUT accepts upload step referencing a fileId from the same project but a different case', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    const cA = await request(app).post('/api/cases').send({ title: 'A', groupId, versionId });
    const other = await pool.query(`INSERT INTO test_cases(group_id, title) VALUES ($1, 'Other') RETURNING id`, [groupId]);
    const caseB = other.rows[0]!.id as string;
    const up = await request(app)
      .post(`/api/cases/${cA.body.id}/attachments`)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Filename', 'shared.txt')
      .send(Buffer.from('shared'));
    const r = await request(app).put(`/api/cases/${caseB}/steps`).send({
      steps: [
        {
          action: { kind: 'upload', locator: [{ strategy: 'css', value: 'input[type=file]' }], fileId: up.body.id },
          source: 'manual',
        },
      ],
    });
    expect(r.status).toBe(200);
    // sanity: projectId is the same
    expect(projectId).toBeDefined();
  });

  it('GET /api/cases/:id/steps/secrets/:stepId returns plaintext for recorder token', async () => {
    process.env.RECORDER_TOKEN_SECRET = 'dev-secret-change-me';
    const { groupId, versionId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'SC', groupId, versionId });
    const put = await request(app).put(`/api/cases/${c.body.id}/steps`).send({
      steps: [
        {
          action: {
            kind: 'fill',
            locator: [{ strategy: 'css', value: 'input[type=password]' }],
            value: 'open-sesame',
            sensitive: true,
          },
          source: 'manual',
        },
      ],
    });
    const stepId = put.body.steps[0].id;
    const r = await request(app)
      .get(`/api/cases/${c.body.id}/steps/secrets/${stepId}`)
      .set('Authorization', 'Bearer dev-secret-change-me');
    expect(r.status).toBe(200);
    expect(r.body.value).toBe('open-sesame');
  });

  it('GET secrets without token returns 403', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'SN', groupId, versionId });
    const put = await request(app).put(`/api/cases/${c.body.id}/steps`).send({
      steps: [
        {
          action: {
            kind: 'fill',
            locator: [{ strategy: 'css', value: '#x' }],
            value: 'v',
            sensitive: true,
          },
          source: 'manual',
        },
      ],
    });
    const stepId = put.body.steps[0].id;
    const r = await request(app).get(`/api/cases/${c.body.id}/steps/secrets/${stepId}`);
    expect(r.status).toBe(403);
  });
});

describe('steps PUT migration', () => {
  it('upgrades legacy assertText on PUT, target=specifiedElement match=equals', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'M', groupId, versionId });
    const r = await request(app)
      .put(`/api/cases/${c.body.id}/steps`)
      .send({
        steps: [
          {
            source: 'manual',
            action: {
              kind: 'assertText',
              locator: [{ strategy: 'css', value: '.msg' }],
              equals: 'ok',
            },
          },
        ],
      });
    expect(r.status).toBe(200);
    const detail = await request(app).get(`/api/cases/${c.body.id}`);
    const a = detail.body.steps[0].action;
    expect(a.target).toBe('specifiedElement');
    expect(a.match).toBe('equals');
    expect(a.intentLocator).toBeUndefined();
  });

  it('preserves explicit target/match on PUT', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'M2', groupId, versionId });
    const r = await request(app)
      .put(`/api/cases/${c.body.id}/steps`)
      .send({
        steps: [
          {
            source: 'manual',
            action: {
              kind: 'assertText',
              locator: [],
              target: 'page' as const,
              match: 'regex' as const,
              equals: '^ok',
            },
          },
        ],
      });
    expect(r.status).toBe(200);
    const detail = await request(app).get(`/api/cases/${c.body.id}`);
    expect(detail.body.steps[0].action.target).toBe('page');
    expect(detail.body.steps[0].action.match).toBe('regex');
  });
});
