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
});

describe('environments project-level model', () => {
  it('POST 创建项目级环境（不再有 versionId 语义）', async () => {
    const r = await request(app).post(`/api/projects/${projectId}/environments`).send({ name: 'dev-test' });
    expect(r.status).toBe(200);
    expect(r.body.projectId).toBe(projectId);
    expect(r.body.versionId).toBeUndefined();
    expect(r.body.objects).toEqual([]);
  });

  it('GET 返回项目全部环境（跨版本共享，无 versionId 过滤）', async () => {
    await request(app).post(`/api/projects/${projectId}/environments`).send({ name: 'dev-test' });
    await request(app).post(`/api/projects/${projectId}/environments`).send({ name: 'pre-prod' });
    const r = await request(app).get(`/api/projects/${projectId}/environments`);
    expect(r.status).toBe(200);
    expect(r.body.map((e: { name: string }) => e.name).sort()).toEqual(['dev-test', 'pre-prod']);
  });

  it('项目内至多一个默认环境（切换默认互斥）', async () => {
    const a = await request(app).post(`/api/projects/${projectId}/environments`).send({ name: 'dev-test' });
    const b = await request(app).post(`/api/projects/${projectId}/environments`).send({ name: 'pre-prod' });
    await request(app).patch(`/api/environments/${a.body.id}`).send({ isDefault: true });
    await request(app).patch(`/api/environments/${b.body.id}`).send({ isDefault: true });
    const r = await request(app).get(`/api/projects/${projectId}/environments`);
    const defaults = r.body.filter((e: { isDefault: boolean }) => e.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(b.body.id);
  });

  it('DELETE 后 project_versions.environment_id 自动置空（SET NULL）', async () => {
    const env = await request(app).post(`/api/projects/${projectId}/environments`).send({ name: 'linked-env' });
    await pool.query(`UPDATE project_versions SET environment_id=$1 WHERE id=$2`, [env.body.id, defaultVersionId]);
    const r = await request(app).delete(`/api/environments/${env.body.id}?confirm=true`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const v = await pool.query(`SELECT environment_id FROM project_versions WHERE id=$1`, [defaultVersionId]);
    expect(v.rows[0]!.environment_id).toBeNull();
  });
});
