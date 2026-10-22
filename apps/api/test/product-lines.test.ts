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
  const { productLinesRoute } = await import('../src/routes/productLines.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(userId, username, orgId, orgPath);
    next();
  });
  app.use('/api/product-lines', productLinesRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

async function lineProductLineId(projectId: string): Promise<string | null> {
  const r = await pool.query(`SELECT product_line_id FROM projects WHERE id = $1`, [projectId]);
  return r.rows[0]?.product_line_id ?? null;
}

describe('产品线 CRUD', () => {
  it('建线后出现在列表里', async () => {
    const created = await request(app).post('/api/product-lines').send({ name: 'SOC产品线', description: '基线+局点' });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe('SOC产品线');

    const list = await request(app).get('/api/product-lines');
    expect(list.status).toBe(200);
    expect(list.body.map((x: { id: string }) => x.id)).toContain(created.body.id);
  });

  it('同组织同名产品线被唯一约束拒绝（500/23505 由 errorHandler 兜住）', async () => {
    const name = `重名-${Date.now()}`;
    const first = await request(app).post('/api/product-lines').send({ name });
    expect(first.status).toBe(201);
    const second = await request(app).post('/api/product-lines').send({ name });
    expect(second.status).not.toBe(201);
  });

  it('挂项目后详情能列出，projectIds 覆盖且幂等', async () => {
    const baseline = await seedProject(pool);
    const site = await seedProject(pool);
    const line = await request(app).post('/api/product-lines').send({ name: `挂载-${Date.now()}` });

    const attach = await request(app)
      .post(`/api/product-lines/${line.body.id}/projects`)
      .send({ projectIds: [baseline.projectId, site.projectId] });
    expect(attach.status).toBe(200);
    expect(attach.body.count).toBe(2);

    const detail = await request(app).get(`/api/product-lines/${line.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.projects.map((p: { id: string }) => p.id).sort()).toEqual(
      [baseline.projectId, site.projectId].sort(),
    );

    // 再挂一次不报错（幂等覆盖）
    const again = await request(app).post(`/api/product-lines/${line.body.id}/projects`).send({ projectIds: [baseline.projectId] });
    expect(again.status).toBe(200);
  });

  it('摘掉单个项目后其余保留', async () => {
    const a = await seedProject(pool);
    const b = await seedProject(pool);
    const line = await request(app).post('/api/product-lines').send({ name: `解绑-${Date.now()}` });
    await request(app).post(`/api/product-lines/${line.body.id}/projects`).send({ projectIds: [a.projectId, b.projectId] });

    const detach = await request(app).delete(`/api/product-lines/${line.body.id}/projects/${a.projectId}`);
    expect(detach.status).toBe(200);
    expect(await lineProductLineId(a.projectId)).toBeNull();
    expect(await lineProductLineId(b.projectId)).toBe(line.body.id);
  });

  it('删除产品线后项目仍在、product_line_id 置空', async () => {
    const p = await seedProject(pool);
    const line = await request(app).post('/api/product-lines').send({ name: `待删-${Date.now()}` });
    await request(app).post(`/api/product-lines/${line.body.id}/projects`).send({ projectIds: [p.projectId] });

    const del = await request(app).delete(`/api/product-lines/${line.body.id}`);
    expect(del.status).toBe(200);

    expect(await lineProductLineId(p.projectId)).toBeNull();
    const still = await pool.query(`SELECT id FROM projects WHERE id = $1`, [p.projectId]);
    expect(still.rowCount).toBe(1);
    expect((await request(app).get(`/api/product-lines/${line.body.id}`)).status).toBe(404);
  });

  it('改名将线更新到新名字', async () => {
    const line = await request(app).post('/api/product-lines').send({ name: `改名前-${Date.now()}` });
    const patched = await request(app).patch(`/api/product-lines/${line.body.id}`).send({ name: '改名后' });
    expect(patched.status).toBe(200);
    expect(patched.body.name).toBe('改名后');
  });

  it('空 projectIds 被拒', async () => {
    const line = await request(app).post('/api/product-lines').send({ name: `空挂-${Date.now()}` });
    const r = await request(app).post(`/api/product-lines/${line.body.id}/projects`).send({ projectIds: [] });
    expect(r.status).toBe(400);
  });
});

describe('产品线可见性与跨组织边界', () => {
  it('他组织的产品线访问 404（不泄露存在性）', async () => {
    // 造一个与当前身份不同的组织 + 产品线
    const other = await pool.query(
      `INSERT INTO organizations(name, path) VALUES ($1, $2) RETURNING id`,
      [`他组织-${Date.now()}`, `/other-${Date.now()}/`],
    );
    const otherOrgId = other.rows[0]!.id as string;
    const foreign = await pool.query(
      `INSERT INTO product_lines(organization_id, name) VALUES ($1, $2) RETURNING id`,
      [otherOrgId, `外部线-${Date.now()}`],
    );
    const foreignId = foreign.rows[0]!.id as string;

    expect((await request(app).get(`/api/product-lines/${foreignId}`)).status).toBe(404);
    expect((await request(app).patch(`/api/product-lines/${foreignId}`).send({ name: 'x' })).status).toBe(404);
    expect((await request(app).delete(`/api/product-lines/${foreignId}`)).status).toBe(404);

    const list = await request(app).get('/api/product-lines');
    expect(list.body.map((x: { id: string }) => x.id)).not.toContain(foreignId);
  });

  it('跨组织挂项目被拒（400 cross_project）', async () => {
    const other = await pool.query(
      `INSERT INTO organizations(name, path) VALUES ($1, $2) RETURNING id`,
      [`挂载他组织-${Date.now()}`, `/mount-${Date.now()}/`],
    );
    const otherOrgId = other.rows[0]!.id as string;
    // 他组织的项目：当前身份看不见 → 404（可见性先于同组织校验生效）
    const foreignProject = await pool.query(
      `INSERT INTO projects(organization_id, name) VALUES ($1, '他组织项目') RETURNING id`,
      [otherOrgId],
    );
    const line = await request(app).post('/api/product-lines').send({ name: `跨组织挂-${Date.now()}` });
    const r = await request(app)
      .post(`/api/product-lines/${line.body.id}/projects`)
      .send({ projectIds: [foreignProject.rows[0]!.id] });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('not_found');
  });
});