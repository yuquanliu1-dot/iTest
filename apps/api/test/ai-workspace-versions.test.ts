import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject, resetSeedOrgCache } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;
let userId: string;
let username: string;
let orgId: string;
let orgPath: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: exp } = await import('express');
  app = exp();
  app.use(exp.json());
  const { requirementsRoute } = await import('../src/routes/requirements.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const org = await seedOrg(pool);
  userId = org.userId;
  username = org.username;
  orgId = org.orgId;
  orgPath = org.orgPath;
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use((req, _res, next) => { req.user = managerUserOf(userId, username, orgId, orgPath); next(); });
  app.use('/api/requirements', requirementsRoute);
  app.use(errorHandler);
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE ai_workspace_state, ai_scenarios, ai_cases, ai_threads, scenarios, test_cases, test_steps, requirements, "groups", projects, project_versions CASCADE`);
  resetSeedOrgCache(pool);
  const org = await seedOrg(pool);
  userId = org.userId;
  username = org.username;
  orgId = org.orgId;
  orgPath = org.orgPath;
});

async function makeRequirement(projectId: string, content = 'c'): Promise<string> {
  const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r', $2, $1) RETURNING id`, [projectId, content]);
  return r.rows[0]!.id as string;
}

describe('ai-workspace save targetVersionId', () => {
  it('未传 targetVersionId 时用例落到默认版本', async () => {
    const ws = await import('../src/pi/workspace.js');
    const { projectId, groupId, versionId } = await seedProject(pool);
    const rid = await makeRequirement(projectId);
    await ws.upsertScenario(rid, { id: 's1', title: 'S', description: null, cases: [
      { id: 'c1', title: 'C1', description: null, priority: 'P1', steps: [{ name: 'n', action: 'a', assertion: null }] },
    ] });
    const r = await request(app).post(`/api/requirements/${rid}/ai-workspace/save`)
      .send({ groupId, scenarioIds: ['s1'], caseIds: ['c1'] });
    expect(r.status).toBe(200);
    const cases = await pool.query(`SELECT version_id FROM test_cases WHERE requirement_id = $1`, [rid]);
    expect(cases.rows[0]!.version_id).toBe(versionId);
  });

  it('显式传 targetVersionId 时用例落到指定版本', async () => {
    const ws = await import('../src/pi/workspace.js');
    const { projectId, groupId } = await seedProject(pool);
    const v1 = await pool.query(
      `INSERT INTO project_versions(project_id, name, is_default) VALUES ($1, 'v1.0', false) RETURNING id`,
      [projectId],
    );
    const v1Id = v1.rows[0]!.id as string;
    const rid = await makeRequirement(projectId);
    await ws.upsertScenario(rid, { id: 's1', title: 'S', description: null, cases: [
      { id: 'c1', title: 'C1', description: null, priority: 'P1', steps: [{ name: 'n', action: 'a', assertion: null }] },
    ] });
    const r = await request(app).post(`/api/requirements/${rid}/ai-workspace/save`)
      .send({ groupId, scenarioIds: ['s1'], caseIds: ['c1'], targetVersionId: v1Id });
    expect(r.status).toBe(200);
    const cases = await pool.query(`SELECT version_id FROM test_cases WHERE requirement_id = $1`, [rid]);
    expect(cases.rows[0]!.version_id).toBe(v1Id);
  });

  it('传跨项目 versionId 返回 400 version_mismatch', async () => {
    const ws = await import('../src/pi/workspace.js');
    const { projectId, groupId } = await seedProject(pool);
    const other = await seedProject(pool);
    const rid = await makeRequirement(projectId);
    await ws.upsertScenario(rid, { id: 's1', title: 'S', description: null, cases: [
      { id: 'c1', title: 'C1', description: null, priority: 'P1', steps: [{ name: 'n', action: 'a', assertion: null }] },
    ] });
    const r = await request(app).post(`/api/requirements/${rid}/ai-workspace/save`)
      .send({ groupId, scenarioIds: ['s1'], caseIds: ['c1'], targetVersionId: other.versionId });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('version_mismatch');
  });
});