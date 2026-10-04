import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  await import('../src/db/client.js');
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

describe('scenarios.service', () => {
  it('requirementProjectId/scenarioProjectId 经 join 解析;归属外 id 返回 null', async () => {
    const { projectId } = await seedProject(pool);
    const rid = (await pool.query(
      `INSERT INTO requirements(project_id, title, content) VALUES ($1,'需求A','c') RETURNING id`, [projectId],
    )).rows[0]!.id as string;
    const svc = await import('../src/services/scenarios.service.js');
    expect(await svc.requirementProjectId(rid)).toBe(projectId);
    expect(await svc.requirementProjectId(randomUUID())).toBeNull();
    const sc = await svc.createScenario(rid, { title: '场景一' });
    expect(await svc.scenarioProjectId(sc.id)).toBe(projectId);
    expect(await svc.scenarioProjectId(randomUUID())).toBeNull();
  }, 30_000);

  it('createScenario order 递增;listScenariosByProject 跨需求全集;update/delete 生效', async () => {
    const { projectId } = await seedProject(pool);
    const rid = (await pool.query(
      `INSERT INTO requirements(project_id, title, content) VALUES ($1,'需求B','c') RETURNING id`, [projectId],
    )).rows[0]!.id as string;
    const svc = await import('../src/services/scenarios.service.js');
    const s1 = await svc.createScenario(rid, { title: 'S1' });
    const s2 = await svc.createScenario(rid, { title: 'S2', description: 'd' });
    expect(s2.order).toBeGreaterThan(s1.order);

    const list = await svc.listScenariosByProject(projectId);
    expect(list.map((r) => r.title).sort()).toEqual(['S1', 'S2']);

    const upd = await svc.updateScenario(s1.id, { title: 'S1改名' });
    expect(upd.title).toBe('S1改名');
    await svc.deleteScenario(s2.id);
    expect(await svc.scenarioProjectId(s2.id)).toBeNull();
    await expect(svc.deleteScenario(s2.id)).rejects.toMatchObject({ status: 404 });
  }, 30_000);
});
