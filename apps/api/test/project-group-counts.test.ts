import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProductLine } from './helpers/db.js';

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
  const { projectsRoute } = await import('../src/routes/projects.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(userId, username, orgId, orgPath);
    next();
  });
  app.use('/api/projects', projectsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

interface Seeded {
  projectId: string;
  groupId: string;
  versionIds: string[];
}

/** 建项目 + 两个分组 + 两个版本，并给「登录系统」组在 v1/v2 各放 1 条用例、「规则管理」组只在 v1 放 2 条。 */
async function seedCasesAcrossVersions(): Promise<Seeded> {
  const { productLineId } = await seedProductLine(pool);
  const p = await pool.query(`INSERT INTO projects(product_line_id, name) VALUES ($1, '计数项目') RETURNING id`, [
    productLineId,
  ]);
  const projectId = p.rows[0]!.id as string;
  const login = await pool.query(`INSERT INTO "groups"(project_id, name) VALUES ($1, '登录系统') RETURNING id`, [projectId]);
  const rule = await pool.query(`INSERT INTO "groups"(project_id, name) VALUES ($1, '规则管理') RETURNING id`, [projectId]);
  const v1 = await pool.query(`INSERT INTO project_versions(project_id, name) VALUES ($1, 'v1') RETURNING id`, [projectId]);
  const v2 = await pool.query(`INSERT INTO project_versions(project_id, name) VALUES ($1, 'v2') RETURNING id`, [projectId]);

  const insertCase = async (groupId: string, versionId: string, title: string) => {
    await pool.query(
      `INSERT INTO test_cases(group_id, version_id, title) VALUES ($1, $2, $3)`,
      [groupId, versionId, title],
    );
  };
  // 登录系统：v1 一条、v2 一条 → 跨版本合计 2
  await insertCase(login.rows[0]!.id, v1.rows[0]!.id, '登录-甲');
  await insertCase(login.rows[0]!.id, v2.rows[0]!.id, '登录-乙');
  // 规则管理：只在 v1 两条 → v1 内 2、v2 内 0
  await insertCase(rule.rows[0]!.id, v1.rows[0]!.id, '规则-甲');
  await insertCase(rule.rows[0]!.id, v1.rows[0]!.id, '规则-乙');

  return {
    projectId,
    groupId: login.rows[0]!.id as string,
    versionIds: [v1.rows[0]!.id as string, v2.rows[0]!.id as string],
  };
}

describe('GET /projects/:id/groups 分组计数随版本范围收窄', () => {
  it('不传 versionIds 时计全版本合计', async () => {
    const { projectId } = await seedCasesAcrossVersions();
    const res = await request(app).get(`/api/projects/${projectId}/groups`);
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.map((g: { name: string; caseCount: number }) => [g.name, g.caseCount]));
    expect(byName['登录系统']).toBe(2);
    expect(byName['规则管理']).toBe(2);
  });

  it('传单个 versionIds 时只数该版本的用例', async () => {
    const { projectId, versionIds } = await seedCasesAcrossVersions();
    const [v1] = versionIds;
    const res = await request(app).get(`/api/projects/${projectId}/groups?versionIds=${v1}`);
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.map((g: { name: string; caseCount: number }) => [g.name, g.caseCount]));
    // v1：登录系统 1 条、规则管理 2 条
    expect(byName['登录系统']).toBe(1);
    expect(byName['规则管理']).toBe(2);
  });

  it('传多版本（逗号分隔）时按集合求和', async () => {
    const { projectId, versionIds } = await seedCasesAcrossVersions();
    const res = await request(app).get(`/api/projects/${projectId}/groups?versionIds=${versionIds.join(',')}`);
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.map((g: { name: string; caseCount: number }) => [g.name, g.caseCount]));
    expect(byName['登录系统']).toBe(2);
    expect(byName['规则管理']).toBe(2);
  });

  it('空 versionIds 参数退化为不收窄（不是 0）', async () => {
    const { projectId } = await seedCasesAcrossVersions();
    const res = await request(app).get(`/api/projects/${projectId}/groups?versionIds=`);
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.map((g: { name: string; caseCount: number }) => [g.name, g.caseCount]));
    expect(byName['登录系统']).toBe(2);
  });
});