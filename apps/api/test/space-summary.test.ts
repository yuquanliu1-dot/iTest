import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
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

describe('buildSpaceSummary', () => {
  it('拼出项目/版本/ref、环境、分组、需求与计数,且不含密钥', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    await pool.query(`UPDATE project_versions SET ref='release-1', ref_kind='tag' WHERE id=$1`, [versionId]);
    await pool.query(`INSERT INTO test_environments(project_id, name, base_url, is_default) VALUES ($1,'生产','https://prod.example.com',true), ($1,'灰度','https://gray.example.com',false)`, [projectId]);
    await pool.query(`INSERT INTO environment_objects(environment_id, object_type, payload) SELECT id,'db',$2 FROM test_environments WHERE project_id=$1 LIMIT 1`, [projectId, JSON.stringify({ host: 'h', password: 'SUPER-SECRET' })]);
    await pool.query(`INSERT INTO requirements(project_id, title, content) VALUES ($1,'登录模块','内容'), ($1,'支付模块','内容')`, [projectId]);
    await pool.query(`INSERT INTO test_cases(group_id, version_id, title) VALUES ($1,$2,'用例A'), ($1,$2,'用例B')`, [groupId, versionId]);
    await pool.query(`INSERT INTO execution_plans(project_id, version_id, name) VALUES ($1,$2,'冒烟计划')`, [projectId, versionId]);

    const { buildSpaceSummary } = await import('../src/pi/space/summary.js');
    const s = await buildSpaceSummary(versionId);
    expect(s.projectId).toBe(projectId);
    expect(s.text).toContain('生产');
    expect(s.text).toContain('https://prod.example.com');
    expect(s.text).toContain('release-1');
    expect(s.text).toContain('登录模块');
    expect(s.text).toContain('用例 2 条');
    expect(s.text).toContain('执行计划 1 个');
    expect(s.text).not.toContain('SUPER-SECRET');
  }, 30_000);

  it('version 不存在 → 抛错', async () => {
    const { buildSpaceSummary } = await import('../src/pi/space/summary.js');
    await expect(buildSpaceSummary('00000000-0000-0000-0000-000000000000')).rejects.toThrow();
  }, 30_000);
});
