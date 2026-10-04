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
  await pool.query(`UPDATE projects SET default_url='https://proj.test' WHERE id=$1`, [projectId]);
});

describe('resolveCaseUrl 解析链', () => {
  it('用例.url 优先于一切', async () => {
    await pool.query(`UPDATE "groups" SET default_url='https://group.test' WHERE id=$1`, [groupId]);
    const url = await resolveCaseUrl({ url: 'https://case.test', groupId }, 'https://env.test');
    expect(url).toBe('https://case.test');
  });

  it('分组.default_url 次之（环境 URL 不越过分组）', async () => {
    await pool.query(`UPDATE "groups" SET default_url='https://group.test' WHERE id=$1`, [groupId]);
    const url = await resolveCaseUrl({ url: null, groupId }, 'https://env.test');
    expect(url).toBe('https://group.test');
  });

  it('环境.base_url 压过项目.default_url（执行期传入 envBaseUrl）', async () => {
    const url = await resolveCaseUrl({ url: null, groupId }, 'https://env.test');
    expect(url).toBe('https://env.test');
  });

  it('不传环境 URL 时项目.default_url 兜底（录制/详情链）', async () => {
    const url = await resolveCaseUrl({ url: null, groupId });
    expect(url).toBe('https://proj.test');
  });
});
