import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';

vi.mock('../db/client.js', () => {
  return {
    db: {
      select: vi.fn(),
    },
  };
});

import { resolveEnv, EnvMissing, EnvProjectMismatch, DecryptError, WebServiceMissing } from './envContext.js';
import { db } from '../db/client.js';
import { encrypt } from '../lib/secret-crypto.js';

const ENV_ROW = { id: 'env-1', projectId: 'proj-1', name: 'staging', isDefault: false, baseUrl: 'https://staging.example.com' };

/** 按 from(表名) 路由的 mock：where() 结果既可 await 也可 .limit()。 */
function mockTables(tables: Record<string, unknown[]>) {
  vi.mocked(db.select).mockImplementation((() => ({
    from: (table: unknown) => {
      const rows = tables[getTableName(table as never)] ?? [];
      return {
        where: () => ({
          limit: () => Promise.resolve(rows),
          orderBy: () => ({ limit: () => Promise.resolve(rows) }),
          then: (onFulfilled: (v: unknown[]) => unknown) => Promise.resolve(rows).then(onFulfilled),
        }),
      };
    },
  })) as never);
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 0).toString('base64');
  mockTables({ test_environments: [ENV_ROW], environment_objects: [], project_versions: [] });
});

describe('resolveEnv', () => {
  it('baseUrl 派生自默认 web 服务 origin', async () => {
    mockTables({
      test_environments: [ENV_ROW],
      environment_objects: [{
        id: 'obj-web', environmentId: 'env-1', objectType: 'web', label: '默认', isDefault: true,
        payload: { name: 'frontend', scheme: 'https', host: 'staging.example.com' },
      }],
      project_versions: [],
    });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    expect(env.baseUrl).toBe('https://staging.example.com');
  });

  it('returns null baseUrl when env has no web objects', async () => {
    mockTables({
      test_environments: [{ ...ENV_ROW, baseUrl: null }],
      environment_objects: [],
      project_versions: [],
    });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    expect(env.baseUrl).toBeNull();
  });

  it('prefers planEnvId over caseEnvId', async () => {
    const { envId } = await resolveEnv({ planEnvId: 'env-plan', caseEnvId: 'env-case' });
    expect(envId).toBe('env-plan');
  });

  it('falls back to caseEnvId', async () => {
    const { envId } = await resolveEnv({ caseEnvId: 'env-case' });
    expect(envId).toBe('env-case');
  });

  it('falls back to version link when plan/case absent', async () => {
    mockTables({
      test_environments: [ENV_ROW],
      environment_objects: [],
      project_versions: [{ environmentId: 'env-from-version' }],
    });
    const { envId } = await resolveEnv({ versionId: 'v-1' });
    expect(envId).toBe('env-from-version');
  });

  it('falls back to project default environment last', async () => {
    mockTables({
      test_environments: [{ ...ENV_ROW, id: 'env-default', isDefault: true }],
      environment_objects: [],
      project_versions: [],
    });
    const { envId } = await resolveEnv({}, { expectedProjectId: 'proj-1' });
    expect(envId).toBe('env-default');
  });

  it('throws EnvMissing when nothing resolves (no guard → no project default lookup)', async () => {
    await expect(resolveEnv({})).rejects.toBeInstanceOf(EnvMissing);
  });

  it('throws EnvMissing when project has no default env', async () => {
    mockTables({ test_environments: [], environment_objects: [], project_versions: [] });
    await expect(resolveEnv({}, { expectedProjectId: 'proj-1' })).rejects.toBeInstanceOf(EnvMissing);
  });

  it('throws EnvProjectMismatch when envId resolves to different project', async () => {
    mockTables({
      test_environments: [{ ...ENV_ROW, projectId: 'other' }],
      environment_objects: [],
      project_versions: [],
    });
    await expect(resolveEnv({ caseEnvId: 'env-1' }, { expectedProjectId: 'proj-1' }))
      .rejects.toBeInstanceOf(EnvProjectMismatch);
  });

  it('builds db pool config from default db object payload', async () => {
    const enc = encrypt('hunter2');
    mockTables({
      test_environments: [ENV_ROW],
      environment_objects: [{
        id: 'obj-db', environmentId: 'env-1', objectType: 'db', label: '默认', isDefault: true,
        payload: {
          host: 'pg.example.com', port: 5433, dbName: 'app', user: 'app',
          secret: { c: enc.ciphertext.toString('base64'), i: enc.iv.toString('base64'), t: enc.tag.toString('base64') },
        },
      }],
      project_versions: [],
    });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    expect(env.db).toEqual({ host: 'pg.example.com', port: 5433, database: 'app', user: 'app', password: 'hunter2' });
    await env.close();
  });

  it('decrypts db password with empty password when secret absent', async () => {
    mockTables({
      test_environments: [ENV_ROW],
      environment_objects: [{
        id: 'obj-db', environmentId: 'env-1', objectType: 'db', label: '默认', isDefault: true,
        payload: { host: 'pg.example.com', dbName: 'app', user: 'app' },
      }],
      project_versions: [],
    });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    expect(env.db?.password).toBe('');
    expect(env.db?.port).toBe(5432);
    await env.close();
  });

  it('throws DecryptError when tag mismatches', async () => {
    const enc = encrypt('hunter2');
    mockTables({
      test_environments: [ENV_ROW],
      environment_objects: [{
        id: 'obj-db', environmentId: 'env-1', objectType: 'db', label: '默认', isDefault: true,
        payload: {
          host: 'pg.example.com', dbName: 'app', user: 'app',
          secret: { c: enc.ciphertext.toString('base64'), i: enc.iv.toString('base64'), t: Buffer.alloc(16, 0xff).toString('base64') },
        },
      }],
      project_versions: [],
    });
    await expect(resolveEnv({ caseEnvId: 'env-1' })).rejects.toBeInstanceOf(DecryptError);
  });

  it('builds syslog ctx from default syslog object payload', async () => {
    const enc = encrypt('KEY');
    mockTables({
      test_environments: [ENV_ROW],
      environment_objects: [{
        id: 'obj-log', environmentId: 'env-1', objectType: 'syslog', label: '默认', isDefault: true,
        payload: {
          host: 'log.example.com', user: 'root', sshPort: 2222, filePath: '/var/log/app.log',
          secret: { c: enc.ciphertext.toString('base64'), i: enc.iv.toString('base64'), t: enc.tag.toString('base64') },
        },
      }],
      project_versions: [],
    });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    expect(env.syslog?.host).toBe('log.example.com');
    expect(env.syslog?.port).toBe(2222);
    expect(env.syslog?.privateKey?.toString()).toBe('KEY');
    expect(env.db).toBeUndefined();
  });

  it('prefers is_default object over older sibling of same type', async () => {
    const encA = encrypt('passA');
    const encB = encrypt('passB');
    mockTables({
      test_environments: [ENV_ROW],
      environment_objects: [
        { id: 'obj-a', environmentId: 'env-1', objectType: 'db', label: '主库', isDefault: false, payload: { host: 'a.db', dbName: 'app', user: 'u', secret: { c: encA.ciphertext.toString('base64'), i: encA.iv.toString('base64'), t: encA.tag.toString('base64') } } },
        { id: 'obj-b', environmentId: 'env-1', objectType: 'db', label: '备库', isDefault: true, payload: { host: 'b.db', dbName: 'app', user: 'u', secret: { c: encB.ciphertext.toString('base64'), i: encB.iv.toString('base64'), t: encB.tag.toString('base64') } } },
      ],
      project_versions: [],
    });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    expect(env.db?.host).toBe('b.db');
    await env.close();
  });

  it('mysql payload → pool dialect mysql, port defaults 3306', async () => {
    const enc = encrypt('mypass');
    mockTables({
      test_environments: [ENV_ROW],
      environment_objects: [{
        id: 'obj-db', environmentId: 'env-1', objectType: 'db', label: '默认', isDefault: true,
        payload: {
          dbType: 'mysql', host: 'mysql.example.com', dbName: 'app', user: 'app',
          secret: { c: enc.ciphertext.toString('base64'), i: enc.iv.toString('base64'), t: enc.tag.toString('base64') },
        },
      }],
      project_versions: [],
    });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    expect(env.pool?.dialect).toBe('mysql');
    expect(env.db?.port).toBe(3306);
    expect(env.db?.password).toBe('mypass');
    await env.close();
  });

  it('postgres payload (dbType absent) → pool dialect postgres, port 5432', async () => {
    const enc = encrypt('pgpass');
    mockTables({
      test_environments: [ENV_ROW],
      environment_objects: [{
        id: 'obj-db', environmentId: 'env-1', objectType: 'db', label: '默认', isDefault: true,
        payload: {
          host: 'pg.example.com', dbName: 'app', user: 'app',
          secret: { c: enc.ciphertext.toString('base64'), i: enc.iv.toString('base64'), t: enc.tag.toString('base64') },
        },
      }],
      project_versions: [],
    });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    expect(env.pool?.dialect).toBe('postgres');
    expect(env.db?.port).toBe(5432);
    await env.close();
  });

  it('syslog password authType → password ctx without privateKey', async () => {
    const enc = encrypt('s3cret');
    mockTables({
      test_environments: [ENV_ROW],
      environment_objects: [{
        id: 'obj-log', environmentId: 'env-1', objectType: 'syslog', label: '默认', isDefault: true,
        payload: {
          host: 'log.example.com', user: 'root', sshPort: 2222, filePath: '/var/log/app.log', authType: 'password',
          secret: { c: enc.ciphertext.toString('base64'), i: enc.iv.toString('base64'), t: enc.tag.toString('base64') },
        },
      }],
      project_versions: [],
    });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    expect(env.syslog?.authType).toBe('password');
    expect(env.syslog?.password).toBe('s3cret');
    expect(env.syslog?.privateKey).toBeUndefined();
    await env.close();
  });

  it('builds login ctx from default login object payload', async () => {
    const enc = encrypt('p@ss');
    mockTables({
      test_environments: [ENV_ROW],
      environment_objects: [{
        id: 'obj-login', environmentId: 'env-1', objectType: 'login', label: '默认', isDefault: true,
        payload: {
          user: 'tom', loginUrl: 'https://staging.example.com/login',
          secret: { c: enc.ciphertext.toString('base64'), i: enc.iv.toString('base64'), t: enc.tag.toString('base64') },
        },
      }],
      project_versions: [],
    });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    expect(env.login).toEqual({ user: 'tom', password: 'p@ss', loginUrl: 'https://staging.example.com/login' });
    await env.close();
  });

  it('login object without secret → login undefined', async () => {
    mockTables({
      test_environments: [ENV_ROW],
      environment_objects: [{
        id: 'obj-login', environmentId: 'env-1', objectType: 'login', label: '默认', isDefault: true,
        payload: { user: 'tom' },
      }],
      project_versions: [],
    });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    expect(env.login).toBeUndefined();
  });

  it('login without loginUrl → loginUrl null', async () => {
    const enc = encrypt('p@ss');
    mockTables({
      test_environments: [ENV_ROW],
      environment_objects: [{
        id: 'obj-login', environmentId: 'env-1', objectType: 'login', label: '默认', isDefault: true,
        payload: { user: 'tom', secret: { c: enc.ciphertext.toString('base64'), i: enc.iv.toString('base64'), t: enc.tag.toString('base64') } },
      }],
      project_versions: [],
    });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    expect(env.login).toEqual({ user: 'tom', password: 'p@ss', loginUrl: null });
    await env.close();
  });
});

describe('webServices / resolveWebOrigin', () => {
  it('构建 web 服务列表,resolveWebOrigin 默认取 isDefault', async () => {
    mockTables({
      test_environments: [ENV_ROW],
      environment_objects: [
        { id: 'obj-web-fe', environmentId: 'env-1', objectType: 'web', label: '前端', isDefault: true, payload: { name: 'frontend', scheme: 'http', host: '192.168.1.10', port: 8080 } },
        { id: 'obj-web-be', environmentId: 'env-1', objectType: 'web', label: '后端', isDefault: false, payload: { name: 'backend', scheme: 'https', host: '192.168.1.11' } },
      ],
      project_versions: [],
    });
    const ctx = await resolveEnv({ caseEnvId: 'env-1' });
    expect(ctx.webServices.map((w) => w.origin).sort()).toEqual(['http://192.168.1.10:8080', 'https://192.168.1.11'].sort());
    expect(ctx.resolveWebOrigin()).toBe('http://192.168.1.10:8080');
    expect(ctx.resolveWebOrigin('backend')).toBe('https://192.168.1.11');
    expect(ctx.baseUrl).toBe('http://192.168.1.10:8080');
  });

  it('ref 不存在抛 WebServiceMissing(带可用清单)', async () => {
    mockTables({
      test_environments: [ENV_ROW],
      environment_objects: [
        { id: 'obj-web-be', environmentId: 'env-1', objectType: 'web', label: '后端', isDefault: false, payload: { name: 'backend', scheme: 'https', host: '192.168.1.11' } },
      ],
      project_versions: [],
    });
    const ctx = await resolveEnv({ caseEnvId: 'env-1' });
    expect(() => ctx.resolveWebOrigin('nope')).toThrow(/nope/);
    expect(() => ctx.resolveWebOrigin('nope')).toThrow(/backend/);
    expect(() => ctx.resolveWebOrigin('nope')).toThrow(WebServiceMissing);
  });

  it('环境无 web 对象返回 null;baseUrl 同为 null(忽略 base_url 列)', async () => {
    mockTables({
      test_environments: [ENV_ROW],
      environment_objects: [],
      project_versions: [],
    });
    const ctx = await resolveEnv({ caseEnvId: 'env-1' });
    expect(ctx.resolveWebOrigin()).toBeNull();
    expect(ctx.baseUrl).toBeNull();
  });

  it('默认端口省略:http:80 与 https:443 不带端口', async () => {
    mockTables({
      test_environments: [ENV_ROW],
      environment_objects: [
        { id: 'obj-web-plain', environmentId: 'env-1', objectType: 'web', label: '默认站', isDefault: false, payload: { name: 'plain', scheme: 'http', host: 'a.com', port: 80 } },
        { id: 'obj-web-secure', environmentId: 'env-1', objectType: 'web', label: '安全站', isDefault: false, payload: { name: 'secure', scheme: 'https', host: 'b.com', port: 443 } },
      ],
      project_versions: [],
    });
    const ctx = await resolveEnv({ caseEnvId: 'env-1' });
    expect(ctx.webServices.find((w) => w.name === 'plain')!.origin).toBe('http://a.com');
    expect(ctx.webServices.find((w) => w.name === 'secure')!.origin).toBe('https://b.com');
  });
});
