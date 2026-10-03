import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject, seedOrg, resetSeedOrgCache } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;
let userId: string;
let username: string;
let orgId: string;
let orgPath: string;
let projectId: string;
let defaultVersionId: string;
let v1Id: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { environmentsRoute } = await import('../src/routes/environments.js');
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
  app.use('/api', environmentsRoute);
  app.use(errorHandler);
}, 60_000);

afterAll(async () => {
  const { pool: p } = await import('../src/db/client.js');
  await p.end().catch(() => undefined);
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE projects, project_versions, "groups", test_cases, test_environments, execution_plans, project_assignments, organizations, users CASCADE`);
  resetSeedOrgCache(pool);
  const org = await seedOrg(pool);
  userId = org.userId;
  username = org.username;
  orgId = org.orgId;
  orgPath = org.orgPath;
  const s = await seedProject(pool);
  projectId = s.projectId;
  defaultVersionId = s.versionId;
  // 新建一个非默认版本
  const v = await pool.query(
    `INSERT INTO project_versions(project_id, name, is_default) VALUES ($1, 'v1.0', false) RETURNING id`,
    [projectId],
  );
  v1Id = v.rows[0]!.id as string;
});

describe('environments versionId filtering', () => {
  it('GET 未传 versionId 时返回默认版本下的环境', async () => {
    const a = await request(app).post(`/api/projects/${projectId}/environments`).send({ name: 'env-default' });
    expect(a.status).toBe(200);
    const r = await request(app).get(`/api/projects/${projectId}/environments`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0].name).toBe('env-default');
    expect(r.body[0].versionId).toBe(defaultVersionId);
  });

  it('GET ?versionId= 过滤到指定版本', async () => {
    const a = await request(app).post(`/api/projects/${projectId}/environments`).send({ name: 'env-default' });
    expect(a.status).toBe(200);
    const b = await request(app)
      .post(`/api/projects/${projectId}/environments`)
      .send({ name: 'env-v1', versionId: v1Id });
    expect(b.status).toBe(200);
    const r = await request(app).get(`/api/projects/${projectId}/environments?versionId=${v1Id}`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0].name).toBe('env-v1');
  });

  it('POST 传非本项目 versionId 返回 400 version_mismatch', async () => {
    // 第二个项目，独立版本
    const other = await seedProject(pool);
    const r = await request(app)
      .post(`/api/projects/${projectId}/environments`)
      .send({ name: 'env-bad', versionId: other.versionId });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('version_mismatch');
  });

  it('POST 不传 versionId 时落入默认版本', async () => {
    const r = await request(app)
      .post(`/api/projects/${projectId}/environments`)
      .send({ name: 'env-no-version' });
    expect(r.status).toBe(200);
    expect(r.body.versionId).toBe(defaultVersionId);
  });
});