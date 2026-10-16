import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject, seedOrg, resetSeedOrgCache } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let resolveCaseUrl: typeof import('../src/lib/resolve-url.js').resolveCaseUrl;
let relativizeUrl: typeof import('../src/lib/resolve-url.js').relativizeUrl;
let WebServiceMissing: typeof import('../src/execute/envContext.js').WebServiceMissing;
let projectId: string;
let groupId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  // db/client.js 在 import 时读 DATABASE_URL，必须等容器就绪后再动态加载（envContext 同理，它引了 db/client）
  ({ resolveCaseUrl, relativizeUrl } = await import('../src/lib/resolve-url.js'));
  ({ WebServiceMissing } = await import('../src/execute/envContext.js'));
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

/** 不走 DB 的 ResolveUrlEnv mock：frontend(默认) + backend 两个 web 服务。 */
const webEnv = () => ({
  envName: '默认环境',
  webServices: [
    { name: 'frontend', label: '前端', origin: 'http://10.0.0.1:8080', isDefault: true },
    { name: 'backend', label: '后端', origin: 'https://10.0.0.2', isDefault: false },
  ],
  resolveWebOrigin: (r?: string | null) =>
    r === 'backend' ? 'https://10.0.0.2'
    : r ? (() => { throw new WebServiceMissing(`环境「默认环境」不存在 web 服务 ${r}`); })()
    : 'http://10.0.0.1:8080',
});

/** 插默认环境 + frontend(默认)/backend 两个 web 对象，返回环境 id。 */
const insertWebEnv = async () => {
  const e = await pool.query(
    `INSERT INTO test_environments(project_id, name, is_default) VALUES ($1, '默认环境', true) RETURNING id`,
    [projectId],
  );
  const envId = e.rows[0]!.id as string;
  await pool.query(
    `INSERT INTO environment_objects(environment_id, object_type, label, payload, is_default) VALUES
      ($1, 'web', '前端', '{"name":"frontend","scheme":"http","host":"10.0.0.1","port":8080}', true),
      ($1, 'web', '后端', '{"name":"backend","scheme":"https","host":"10.0.0.2"}', false)`,
    [envId],
  );
  return envId;
};

describe('resolveCaseUrl 新解析链', () => {
  it('绝对 url 直通（不读环境）', async () => {
    const url = await resolveCaseUrl({ url: 'https://case.test/x', groupId }, { envCtx: webEnv() });
    expect(url).toBe('https://case.test/x');
  });

  it('相对 url 拼默认服务 origin', async () => {
    const url = await resolveCaseUrl({ url: '/admin/user?x=1', groupId }, { envCtx: webEnv() });
    expect(url).toBe('http://10.0.0.1:8080/admin/user?x=1');
  });

  it('相对 url + webServiceRef 拼指定服务 origin', async () => {
    const url = await resolveCaseUrl({ url: '/api', webServiceRef: 'backend', groupId }, { envCtx: webEnv() });
    expect(url).toBe('https://10.0.0.2/api');
  });

  it('url 空取默认服务 origin；无 envCtx 且不兜底返回 null', async () => {
    expect(await resolveCaseUrl({ url: null, groupId }, { envCtx: webEnv() })).toBe('http://10.0.0.1:8080');
    expect(await resolveCaseUrl({ url: null, groupId })).toBeNull();
  });

  it('defaultEnvFallback（录制/展示链）兜底项目默认环境的默认 web 服务', async () => {
    await insertWebEnv();
    const url = await resolveCaseUrl({ url: '/login', groupId }, { defaultEnvFallback: true });
    expect(url).toBe('http://10.0.0.1:8080/login');
  });

  it('环境无 web 服务 + 相对 url → WebServiceMissing', async () => {
    await pool.query(`INSERT INTO test_environments(project_id, name, is_default) VALUES ($1, '空环境', true)`, [projectId]);
    await expect(resolveCaseUrl({ url: '/x', groupId }, { defaultEnvFallback: true })).rejects.toThrow(WebServiceMissing);
  });

  it('webServiceRef 不存在 → WebServiceMissing（含 ref 名）', async () => {
    await insertWebEnv();
    await expect(
      resolveCaseUrl({ url: '/api', webServiceRef: 'nope', groupId }, { envCtx: webEnv() }),
    ).rejects.toThrow(/nope/);
    await expect(
      resolveCaseUrl({ url: '/api', webServiceRef: 'nope', groupId }, { defaultEnvFallback: true }),
    ).rejects.toThrow(/nope/);
  });
});

describe('relativizeUrl', () => {
  const origins: Map<string, string | null> = new Map([
    ['http://10.0.0.1:8080', 'frontend'],
    ['https://10.0.0.2', 'backend'],
    ['http://10.0.0.3', null],
  ]);

  it('命中命名服务返回 { path, ref: name }', () => {
    expect(relativizeUrl('http://10.0.0.1:8080/admin/user?x=1#sec', origins)).toEqual({
      path: '/admin/user?x=1#sec',
      ref: 'frontend',
    });
  });

  it('命中未命名默认服务返回 { path, ref: null }', () => {
    expect(relativizeUrl('http://10.0.0.3/home', origins)).toEqual({ path: '/home', ref: null });
  });

  it('未命中 origin 返回 null（保留绝对）', () => {
    expect(relativizeUrl('https://other.test/x', origins)).toBeNull();
  });

  it('非 http(s) 返回 null', () => {
    expect(relativizeUrl('about:blank', origins)).toBeNull();
    expect(relativizeUrl('file:///tmp/x', origins)).toBeNull();
  });
});
