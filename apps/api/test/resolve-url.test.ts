import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject, seedOrg, resetSeedOrgCache } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let resolveCaseUrl: typeof import('../src/lib/resolve-url.js').resolveCaseUrl;
let projectId: string;
let groupId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  // db/client.js 在 import 时读 DATABASE_URL，必须等容器就绪后再动态加载
  ({ resolveCaseUrl } = await import('../src/lib/resolve-url.js'));
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
  await seedOrg(pool);
  const s = await seedProject(pool);
  projectId = s.projectId;
  groupId = s.groupId;
});

describe('resolveCaseUrl 解析链', () => {
  it('用例.url 优先于一切', async () => {
    await pool.query(`UPDATE "groups" SET default_url='https://group.test' WHERE id=$1`, [groupId]);
    const url = await resolveCaseUrl({ url: 'https://case.test', groupId }, { envBaseUrl: 'https://env.test' });
    expect(url).toBe('https://case.test');
  });

  it('分组.default_url 次之（环境 URL 不越过分组）', async () => {
    await pool.query(`UPDATE "groups" SET default_url='https://group.test' WHERE id=$1`, [groupId]);
    await pool.query(`INSERT INTO test_environments(project_id, name, is_default, base_url) VALUES ($1, '默认', true, 'https://env.test')`, [projectId]);
    const url = await resolveCaseUrl({ url: null, groupId }, { envBaseUrl: 'https://plan-env.test', defaultEnvFallback: true });
    expect(url).toBe('https://group.test');
  });

  it('录制/展示链兜底到项目默认环境.base_url', async () => {
    await pool.query(`INSERT INTO test_environments(project_id, name, is_default, base_url) VALUES ($1, '默认', true, 'https://env.test')`, [projectId]);
    const url = await resolveCaseUrl({ url: null, groupId }, { defaultEnvFallback: true });
    expect(url).toBe('https://env.test');
  });

  it('执行链 envBaseUrl（已解析环境）优先于默认环境兜底', async () => {
    await pool.query(`INSERT INTO test_environments(project_id, name, is_default, base_url) VALUES ($1, '默认', true, 'https://env.test')`, [projectId]);
    const url = await resolveCaseUrl({ url: null, groupId }, { envBaseUrl: 'https://plan-env.test', defaultEnvFallback: true });
    expect(url).toBe('https://plan-env.test');
  });

  it('无环境 URL 且不兜底时返回 null（默认环境 base_url 为空同样 null）', async () => {
    expect(await resolveCaseUrl({ url: null, groupId })).toBeNull();
    await pool.query(`INSERT INTO test_environments(project_id, name, is_default) VALUES ($1, '默认', true)`, [projectId]);
    expect(await resolveCaseUrl({ url: null, groupId }, { defaultEnvFallback: true })).toBeNull();
  });
});
