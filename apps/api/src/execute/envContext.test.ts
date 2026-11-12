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

/** Mock routed by from(table name): the where() result is both awaitable and .limit()-able. */
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

  // Case shared in across product lines: the fallback to the project's own default env stays in effect; only the ownership re-check is exempted.
  it('still falls back to project default env when allowCrossProjectEnv is set', async () => {
    mockTables({
      test_environments: [{ ...ENV_ROW, id: 'env-default', isDefault: true, projectId: 'proj-1' }],
      environment_objects: [],
      project_versions: [],
    });
    const { envId } = await resolveEnv({}, { expectedProjectId: 'proj-1', allowCrossProjectEnv: true });
    expect(envId).toBe('env-default');
  });

  it('accepts another project env when allowCrossProjectEnv is set', async () => {
    mockTables({
      test_environments: [{ ...ENV_ROW, projectId: 'other' }],
      environment_objects: [],
      project_versions: [],
    });
    const { envId } = await resolveEnv({ planEnvId: 'env-1' }, { expectedProjectId: 'proj-1', allowCrossProjectEnv: true });
    expect(envId).toBe('env-1');
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

  it('gauss100 payload → pool dialect gauss100, port 2888, 未配桥时 query 抛 GaussBridgeMissing（懒失败）', async () => {
    const enc = encrypt('gspass');
    mockTables({
      test_environments: [ENV_ROW],
      environment_objects: [{
        id: 'obj-db', environmentId: 'env-1', objectType: 'db', label: '默认', isDefault: true,
        payload: {
          dbType: 'gauss100', host: 'gauss.example.com', dbName: 'BSSPUB', user: 'BSSPUB',
          secret: { c: enc.ciphertext.toString('base64'), i: enc.iv.toString('base64'), t: enc.tag.toString('base64') },
        },
      }],
      project_versions: [],
    });
    const prev = process.env.GAUSS_BRIDGE_URL;
    delete process.env.GAUSS_BRIDGE_URL;
    try {
      const env = await resolveEnv({ caseEnvId: 'env-1' });
      expect(env.pool?.dialect).toBe('gauss100');
      expect(env.db?.port).toBe(2888);
      expect(env.db?.password).toBe('gspass');
      // Lazy failure: pool creation doesn't throw (test-db builds the pool outside try); the named error only throws on the first query call
      await expect(env.pool!.query('SELECT 1', [])).rejects.toMatchObject({ name: 'GaussBridgeMissing' });
      await env.close();
    } finally {
      if (prev !== undefined) process.env.GAUSS_BRIDGE_URL = prev;
    }
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

  it('命名 syslog：syslogs 列全部，resolveSyslog 按 label，未命中返回 null', async () => {
    const encA = encrypt('pw1');
    const encB = encrypt('pw2');
    mockTables({
      test_environments: [ENV_ROW],
      environment_objects: [
        {
          id: 's-1', environmentId: 'env-1', objectType: 'syslog', label: '主日志机', isDefault: true,
          payload: {
            host: 'h1', user: 'u1', sshPort: 22, filePath: '/var/log/a.log', authType: 'password',
            secret: { c: encA.ciphertext.toString('base64'), i: encA.iv.toString('base64'), t: encA.tag.toString('base64') },
          },
        },
        {
          id: 's-2', environmentId: 'env-1', objectType: 'syslog', label: '审计机', isDefault: false,
          payload: {
            host: 'h2', user: 'u2', sshPort: 2222, filePath: '/var/log/b.log', authType: 'password',
            secret: { c: encB.ciphertext.toString('base64'), i: encB.iv.toString('base64'), t: encB.tag.toString('base64') },
          },
        },
      ],
      project_versions: [],
    });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    expect(env.syslogs.map((s) => s.label)).toEqual(['主日志机', '审计机']);
    expect(env.resolveSyslog('审计机')?.host).toBe('h2');
    expect(env.resolveSyslog()?.host).toBe('h1');
    // An explicit ref miss never silently falls back to the default — better a hard error than connecting to the wrong machine and reading someone else's logs.
    expect(env.resolveSyslog('nope')).toBeNull();
    // The legacy field syslog still points at the default entry
    expect(env.syslog?.host).toBe('h1');
    await env.close();
  });

  it('syslog 缺 secret 的条目不进 syslogs，但不影响其余条目', async () => {
    const enc = encrypt('pw1');
    mockTables({
      test_environments: [ENV_ROW],
      environment_objects: [
        {
          id: 's-1', environmentId: 'env-1', objectType: 'syslog', label: '完整的', isDefault: true,
          payload: {
            host: 'h1', user: 'u1', filePath: '/var/log/a.log', authType: 'password',
            secret: { c: enc.ciphertext.toString('base64'), i: enc.iv.toString('base64'), t: enc.tag.toString('base64') },
          },
        },
        {
          id: 's-bad', environmentId: 'env-1', objectType: 'syslog', label: '缺密钥的', isDefault: false,
          payload: { host: 'h2', user: 'u2', filePath: '/var/log/b.log' },
        },
      ],
      project_versions: [],
    });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    expect(env.syslogs.map((s) => s.label)).toEqual(['完整的']);
    expect(env.resolveSyslog('缺密钥的')).toBeNull();
    await env.close();
  });

  // Regression: when the default syslog is incomplete, never silently fall back to another complete entry.
  // Connecting to the wrong machine reads someone else's logs → misjudged assertions, far harder to troubleshoot than outright failure.
  it('默认 syslog 不完整时判死（不回落其它完整记录）', async () => {
    const enc = encrypt('pw1');
    const sec = { c: enc.ciphertext.toString('base64'), i: enc.iv.toString('base64'), t: enc.tag.toString('base64') };
    mockTables({
      test_environments: [ENV_ROW],
      environment_objects: [
        // default but missing filePath
        { id: 's-bad-def', environmentId: 'env-1', objectType: 'syslog', label: '残缺的默认机', isDefault: true,
          payload: { host: 'h1', user: 'u1', authType: 'password', secret: sec } },
        // non-default and complete
        { id: 's-ok', environmentId: 'env-1', objectType: 'syslog', label: '好机', isDefault: false,
          payload: { host: 'h2', user: 'u2', filePath: '/var/log/b.log', authType: 'password', secret: sec } },
      ],
      project_versions: [],
    });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    expect(env.syslogs.map((s) => s.label)).toEqual(['好机']);
    // Default selection judged dead — no silent fallback to 「好机」
    expect(env.resolveSyslog()).toBeNull();
    expect(env.syslog).toBeUndefined();
    await env.close();
  });

  it('builds login ctx from default web object embedded credential', async () => {
    const enc = encrypt('p@ss');
    mockTables({
      test_environments: [ENV_ROW],
      environment_objects: [{
        id: 'obj-web', environmentId: 'env-1', objectType: 'web', label: '默认', isDefault: true,
        payload: {
          name: 'frontend', scheme: 'https', host: 'staging.example.com',
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

  it('web object without secret → login undefined', async () => {
    mockTables({
      test_environments: [ENV_ROW],
      environment_objects: [{
        id: 'obj-web', environmentId: 'env-1', objectType: 'web', label: '默认', isDefault: true,
        payload: { name: 'frontend', scheme: 'https', host: 'staging.example.com', user: 'tom' },
      }],
      project_versions: [],
    });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    expect(env.login).toBeUndefined();
  });

  it('web credential without loginUrl → loginUrl null', async () => {
    const enc = encrypt('p@ss');
    mockTables({
      test_environments: [ENV_ROW],
      environment_objects: [{
        id: 'obj-web', environmentId: 'env-1', objectType: 'web', label: '默认', isDefault: true,
        payload: {
          name: 'frontend', scheme: 'https', host: 'staging.example.com', user: 'tom',
          secret: { c: enc.ciphertext.toString('base64'), i: enc.iv.toString('base64'), t: enc.tag.toString('base64') },
        },
      }],
      project_versions: [],
    });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    expect(env.login).toEqual({ user: 'tom', password: 'p@ss', loginUrl: null });
    await env.close();
  });

  it('multiple web objects → login 取默认 web 的内嵌凭据', async () => {
    const encA = encrypt('admin-pass');
    const encB = encrypt('backend-pass');
    mockTables({
      test_environments: [ENV_ROW],
      environment_objects: [
        { id: 'obj-web-fe', environmentId: 'env-1', objectType: 'web', label: '前端', isDefault: true, payload: { name: 'frontend', scheme: 'https', host: 'fe.example.com', user: 'fe-admin', secret: { c: encA.ciphertext.toString('base64'), i: encA.iv.toString('base64'), t: encA.tag.toString('base64') } } },
        { id: 'obj-web-be', environmentId: 'env-1', objectType: 'web', label: '后端', isDefault: false, payload: { name: 'backend', scheme: 'https', host: 'be.example.com', user: 'be-admin', secret: { c: encB.ciphertext.toString('base64'), i: encB.iv.toString('base64'), t: encB.tag.toString('base64') } } },
      ],
      project_versions: [],
    });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    expect(env.login).toEqual({ user: 'fe-admin', password: 'admin-pass', loginUrl: null });
    await env.close();
  });
});

describe('resolveEnv 命名 db', () => {
  /** Embedded ciphertext triple (matches encrypt's output). */
  const secretOf = (pw: string) => {
    const enc = encrypt(pw);
    return { c: enc.ciphertext.toString('base64'), i: enc.iv.toString('base64'), t: enc.tag.toString('base64') };
  };
  const dbObjs = () => [
    { id: 'd-m', environmentId: 'env-1', objectType: 'db', label: '主库', isDefault: true,
      payload: { host: 'pg-main', dbName: 'main', user: 'u1', secret: secretOf('p1') } },
    { id: 'd-o', environmentId: 'env-1', objectType: 'db', label: 'olap', isDefault: false,
      payload: { host: 'my-olap', dbName: 'dw', dbType: 'mysql', user: 'u2', secret: secretOf('p2') } },
    { id: 'd-bad', environmentId: 'env-1', objectType: 'db', label: '缺字段', isDefault: false, payload: {} },
  ];

  it('dbs 列出全部配置完整的 db（label 即 ref），缺字段的跳过', async () => {
    mockTables({ test_environments: [ENV_ROW], environment_objects: dbObjs(), project_versions: [] });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    expect(env.dbs.map((d) => d.label)).toEqual(['主库', 'olap']);
    expect(env.resolveDb('olap')?.dialect).toBe('mysql');
    expect(env.resolveDb()?.label).toBe('主库');
    expect(env.resolveDb('nope')).toBeNull();
    await env.close();
  });

  it('db / pool 降为默认 db 的派生 getter；pool 惰建且缓存同一实例', async () => {
    mockTables({ test_environments: [ENV_ROW], environment_objects: dbObjs(), project_versions: [] });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    expect(env.db).toEqual({ host: 'pg-main', port: 5432, database: 'main', user: 'u1', password: 'p1' });
    const p = env.pool;
    expect(p?.dialect).toBe('postgres');
    expect(env.pool).toBe(p); // cached, not rebuilt
    await env.close();
  });

  it('resolveDbPool 按 ref 取池：同 ref 同实例、不同 ref 不同实例', async () => {
    mockTables({ test_environments: [ENV_ROW], environment_objects: dbObjs(), project_versions: [] });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    const main1 = await env.resolveDbPool('主库');
    const main2 = await env.resolveDbPool('主库');
    const olap = await env.resolveDbPool('olap');
    expect(main2).toBe(main1);
    expect(olap).not.toBe(main1);
    expect(olap.dialect).toBe('mysql');
    await env.close();
  });

  it('resolveDbPool 未命中 → EnvDbMissing 具名错误（消息点名 ref 与可用清单）', async () => {
    mockTables({ test_environments: [ENV_ROW], environment_objects: dbObjs(), project_versions: [] });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    const e = await env.resolveDbPool('nope').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).name).toBe('EnvDbMissing');
    expect((e as Error).message).toContain('nope');
    expect((e as Error).message).toContain('主库');
    await env.close();
  });

  it('close() 结束所有已建池并清空缓存（再次取池得到新实例）', async () => {
    mockTables({ test_environments: [ENV_ROW], environment_objects: dbObjs(), project_versions: [] });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    const first = await env.resolveDbPool('主库');
    await env.close();
    const second = await env.resolveDbPool('主库');
    expect(second).not.toBe(first);
    await env.close();
  });

  // Regression: when the default db is incompletely configured, never silently fall back to another complete db.
  // The old semantics (pick('db') selecting before validating) would judge dead and report 「未配置数据库对象」;
  // after 4f9a591 moved the completeness filter before selection, an incomplete default db got skipped → silently connected elsewhere.
  // Silently connecting to the wrong db is far harder to troubleshoot than an error: results look normal, but a different dataset is being queried.
  it('默认 db 不完整时判死（不回落其它完整库）', async () => {
    const secretOf = (pw: string) => {
      const enc = encrypt(pw);
      return { c: enc.ciphertext.toString('base64'), i: enc.iv.toString('base64'), t: enc.tag.toString('base64') };
    };
    mockTables({
      test_environments: [ENV_ROW],
      environment_objects: [
        // default but missing dbName
        { id: 'd-bad-def', environmentId: 'env-1', objectType: 'db', label: '残缺的默认库', isDefault: true,
          payload: { host: 'pg-main', user: 'u1', secret: secretOf('p1') } },
        // non-default and complete
        { id: 'd-ok', environmentId: 'env-1', objectType: 'db', label: '好库', isDefault: false,
          payload: { host: 'h2', dbName: 'd', user: 'u2', secret: secretOf('p2') } },
      ],
      project_versions: [],
    });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    // The complete db is still in the list (referable by explicit ref)
    expect(env.dbs.map((d) => d.label)).toEqual(['好库']);
    // But default selection is judged dead — no silent fallback to 「好库」
    expect(env.resolveDb()).toBeNull();
    expect(env.db).toBeUndefined();
    expect(env.pool).toBeUndefined();
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

describe('resolveEnv 多 web 凭据', () => {
  /** secret triple of the embedded credentials (matches encrypt's output). */
  const credOf = (user: string, pw: string) => {
    const enc = encrypt(pw);
    return {
      user,
      secret: { c: enc.ciphertext.toString('base64'), i: enc.iv.toString('base64'), t: enc.tag.toString('base64') },
    };
  };
  const twoWebs = () => [
    { id: 'w-b', environmentId: 'env-1', objectType: 'web', label: '后端', isDefault: false,
      payload: { name: 'backend', scheme: 'http', host: '10.0.0.1', port: 90, ...credOf('admin', 'pw9') } },
    { id: 'w-f', environmentId: 'env-1', objectType: 'web', label: '前端', isDefault: true,
      payload: { name: 'frontend', scheme: 'http', host: '10.0.0.2', port: 1688, ...credOf('guest', 'pw8') } },
  ];

  it('logins 收齐每个已配凭据的命名 web 服务', async () => {
    mockTables({ test_environments: [ENV_ROW], environment_objects: twoWebs(), project_versions: [] });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    expect([...env.logins.keys()].sort()).toEqual(['backend', 'frontend']);
    expect(env.resolveLogin('backend')?.user).toBe('admin');
    expect(env.resolveLogin('frontend')?.password).toBe('pw8');
  });

  it('resolveLogin 无 ref → 默认 web；未知 ref → null（不静默回落默认）', async () => {
    mockTables({ test_environments: [ENV_ROW], environment_objects: twoWebs(), project_versions: [] });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    expect(env.resolveLogin()?.user).toBe('guest');       // isDefault=frontend
    expect(env.resolveLogin('nope')).toBeNull();
    // The legacy field login still holds the default web's (zero changes to existing consumers)
    expect(env.login?.user).toBe('guest');
  });

  it('hasCredentials：只反映有无，不泄漏任何值；无名 web 不可按名引用', async () => {
    const objs = [
      ...twoWebs(),
      { id: 'w-x', environmentId: 'env-1', objectType: 'web', label: '无凭据', isDefault: false,
        payload: { name: 'staging', scheme: 'https', host: '10.0.0.9' } },
      { id: 'w-n', environmentId: 'env-1', objectType: 'web', label: '无名', isDefault: false,
        payload: { scheme: 'https', host: '10.0.0.10', ...credOf('u', 'p') } },
    ];
    mockTables({ test_environments: [ENV_ROW], environment_objects: objs, project_versions: [] });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    expect(env.hasCredentials('backend')).toBe(true);
    expect(env.hasCredentials('staging')).toBe(false);
    expect(env.hasCredentials('nope')).toBe(false);
    // Objects without payload.name don't enter logins (not referable, consistent with the established semantics)
    expect(env.logins.has('')).toBe(false);
    expect([...env.logins.values()].some((l) => l.user === 'u')).toBe(false);
  });
});
