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

describe('environments.service', () => {
  it('createEnvironment:name 唯一,重复 → 409;listEnvironments 带脱敏 objects', async () => {
    const { projectId } = await seedProject(pool);
    const svc = await import('../src/services/environments.service.js');
    const env = await svc.createEnvironment(projectId, { name: '生产' });
    await svc.insertEnvironmentObject(env.id, { objectType: 'db', payload: { host: 'h', dbName: 'd', user: 'u', password: 'SUPER-SECRET' }, isDefault: true });
    await expect(svc.createEnvironment(projectId, { name: '生产' })).rejects.toMatchObject({ status: 409, code: 'name_conflict' });

    const list = await svc.listEnvironments(projectId);
    expect(list).toHaveLength(1);
    expect(list[0]!.objects).toHaveLength(1);
    expect(JSON.stringify(list[0]!.objects)).not.toContain('SUPER-SECRET');
    expect(JSON.stringify(list[0]!.objects)).toContain('••••••••');
    expect(list[0]!.objects[0]!.hasSecret).toBe(true);
  }, 30_000);

  it('updateEnvironment:isDefault 互斥;upsertEnvironmentObject 合并保留旧密文,set_secret 换新密文', async () => {
    const { projectId } = await seedProject(pool);
    const svc = await import('../src/services/environments.service.js');
    const e1 = await svc.createEnvironment(projectId, { name: 'E1' });
    const e2 = await svc.createEnvironment(projectId, { name: 'E2' });
    const u1 = await svc.updateEnvironment(e1.id, { isDefault: true });
    expect(u1.isDefault).toBe(true);
    const u2 = await svc.updateEnvironment(e2.id, { isDefault: true });
    expect(u2.isDefault).toBe(true);
    const again = await svc.getEnvironment(e1.id);
    expect(again!.isDefault).toBe(false); // 被互斥降级

    const obj = await svc.insertEnvironmentObject(e1.id, { objectType: 'db', payload: { host: 'h' } });
    // upsert 同 (type,label):合并 payload;不带明文 → 旧密文保留
    await svc.setEnvironmentObjectSecret(obj.id, 'OLD-SECRET');
    const up = await svc.upsertEnvironmentObject(e1.id, { objectType: 'db', payload: { host: 'h2' } });
    const raw1 = (await pool.query(`SELECT payload FROM environment_objects WHERE id=$1`, [obj.id])).rows[0]!.payload as Record<string, unknown>;
    expect((raw1 as { host: string }).host).toBe('h2');
    expect((raw1 as { secret?: { c: string } }).secret?.c).toBeTruthy();
    expect(JSON.stringify(raw1)).not.toContain('OLD-SECRET');
    expect(up.payload.secret).toBe('••••••••');
    expect(JSON.stringify(up)).not.toContain('OLD-SECRET');

    // set_secret 换新密文
    await svc.setEnvironmentObjectSecret(obj.id, 'NEW-SECRET');
    const raw2 = (await pool.query(`SELECT payload FROM environment_objects WHERE id=$1`, [obj.id])).rows[0]!.payload as { secret: { c: string } };
    expect(raw2.secret.c).toBeTruthy();
    expect(Buffer.from(raw2.secret.c, 'base64').toString()).not.toContain('NEW-SECRET'); // 密文不是明文
  }, 30_000);

  it('deleteEnvironmentObject 晋升同类型兄弟为默认;environmentUsage 统计;deleteEnvironment 级联', async () => {
    const { projectId, versionId } = await seedProject(pool);
    const svc = await import('../src/services/environments.service.js');
    const env = await svc.createEnvironment(projectId, { name: 'D' });
    const o1 = await svc.insertEnvironmentObject(env.id, { objectType: 'db', label: 'A', payload: {}, isDefault: true });
    const o2 = await svc.insertEnvironmentObject(env.id, { objectType: 'db', label: 'B', payload: {} });
    await svc.deleteEnvironmentObject(o1.id);
    const detail = await svc.getEnvironment(env.id);
    const b = detail!.objects.find((o) => o.label === 'B');
    expect(b!.isDefault).toBe(true);

    await pool.query(`INSERT INTO test_cases(group_id, version_id, title, default_env_id) SELECT id,$1,'c',$2 FROM groups WHERE project_id=$3 LIMIT 1`, [versionId, env.id, projectId]);
    const usage = await svc.environmentUsage(env.id);
    expect(usage.caseCount).toBe(1);
    await svc.deleteEnvironment(env.id);
    const raw = await pool.query(`SELECT default_env_id FROM test_cases WHERE title='c'`);
    expect(raw.rows[0]!.default_env_id).toBeNull(); // FK SET NULL
  }, 30_000);

  it('web 对象携带登录凭据:密码加密进 secret,user/loginUrl 明文;留空沿用旧密文;入参 secret 丢弃', async () => {
    const { projectId } = await seedProject(pool);
    const svc = await import('../src/services/environments.service.js');
    const env = await svc.createEnvironment(projectId, { name: 'L' });
    const obj = await svc.insertEnvironmentObject(env.id, {
      objectType: 'web',
      payload: { name: 'frontend', scheme: 'https', host: 'x.example.com', user: 'tom', loginUrl: '/login', password: 'LOGIN-PASS' },
      isDefault: true,
    });
    // 出参脱敏,明文字段保留
    expect((obj.payload as { user: string }).user).toBe('tom');
    expect((obj.payload as { loginUrl: string }).loginUrl).toBe('/login');
    expect((obj.payload as { secret: string }).secret).toBe('••••••••');
    expect(obj.hasSecret).toBe(true);
    const raw = (await pool.query(`SELECT payload FROM environment_objects WHERE id=$1`, [obj.id])).rows[0]!.payload as { secret?: { c?: string } };
    expect(JSON.stringify(raw)).not.toContain('LOGIN-PASS');
    expect(raw.secret?.c).toBeTruthy();

    // 更新不带密码 → 旧密文沿用;入参 secret 一律丢弃(update 为整体替换语义,须带全量 web 字段)
    const before = raw.secret!.c;
    const up = await svc.updateEnvironmentObject(obj.id, {
      payload: { name: 'frontend', scheme: 'https', host: 'x.example.com', user: 'jerry', loginUrl: '/login', secret: 'evil-plain' } as Record<string, unknown>,
    });
    expect((up.payload as { user: string }).user).toBe('jerry');
    const raw2 = (await pool.query(`SELECT payload FROM environment_objects WHERE id=$1`, [obj.id])).rows[0]!.payload as { secret?: { c?: string } };
    expect(raw2.secret?.c).toBeTruthy();
    expect(raw2.secret!.c).not.toContain('evil-plain');
    // 密钥未变 → 密文不变（沿用而非重新加密）
    expect(raw2.secret!.c).toBe(before);
  }, 30_000);

  describe('web 对象', () => {
    it('可创建 web 对象,name 合法时保存', async () => {
      const { projectId } = await seedProject(pool);
      const svc = await import('../src/services/environments.service.js');
      const env = await svc.createEnvironment(projectId, { name: 'W' });
      const obj = await svc.insertEnvironmentObject(env.id, {
        objectType: 'web',
        payload: { name: 'backend', scheme: 'https', host: '192.168.1.11', port: 8081 },
        isDefault: true,
      });
      expect(obj.objectType).toBe('web');
      expect((obj.payload as Record<string, unknown>).name).toBe('backend');
    }, 30_000);

    it('同环境 name 重复(不同 label)被拒', async () => {
      const { projectId } = await seedProject(pool);
      const svc = await import('../src/services/environments.service.js');
      const env = await svc.createEnvironment(projectId, { name: 'W' });
      await svc.insertEnvironmentObject(env.id, { objectType: 'web', payload: { name: 'web', scheme: 'http', host: 'a.com' } });
      await expect(svc.insertEnvironmentObject(env.id, {
        objectType: 'web', label: '第二个',
        payload: { name: 'web', scheme: 'http', host: 'b.com' },
      })).rejects.toThrow(/name.*已存在|conflict/i);
    }, 30_000);

    it('name 非法变量名字符被拒', async () => {
      const { projectId } = await seedProject(pool);
      const svc = await import('../src/services/environments.service.js');
      const env = await svc.createEnvironment(projectId, { name: 'W' });
      await expect(svc.insertEnvironmentObject(env.id, {
        objectType: 'web', payload: { name: '后端', scheme: 'http', host: 'a.com' },
      })).rejects.toThrow(/name/);
    }, 30_000);

    it('host 缺失被拒', async () => {
      const { projectId } = await seedProject(pool);
      const svc = await import('../src/services/environments.service.js');
      const env = await svc.createEnvironment(projectId, { name: 'W' });
      await expect(svc.insertEnvironmentObject(env.id, {
        objectType: 'web', payload: { name: 'web', scheme: 'http' },
      })).rejects.toThrow(/host/);
    }, 30_000);

    it('createEnvironment objects[] 带合法 web 对象创建成功', async () => {
      const { projectId } = await seedProject(pool);
      const svc = await import('../src/services/environments.service.js');
      const env = await svc.createEnvironment(projectId, {
        name: 'W',
        objects: [{ objectType: 'web', payload: { name: 'api', scheme: 'https', host: '192.168.1.11', port: 8081 }, isDefault: true }],
      });
      const detail = await svc.getEnvironment(env.id);
      const web = detail!.objects.find((o) => o.objectType === 'web');
      expect((web!.payload as Record<string, unknown>).name).toBe('api');
    }, 30_000);

    it('createEnvironment objects[] 两个同名 web 对象被拒', async () => {
      const { projectId } = await seedProject(pool);
      const svc = await import('../src/services/environments.service.js');
      await expect(svc.createEnvironment(projectId, {
        name: 'W',
        objects: [
          { objectType: 'web', payload: { name: 'dup', scheme: 'http', host: 'a.com' } },
          { objectType: 'web', label: '第二个', payload: { name: 'dup', scheme: 'http', host: 'b.com' } },
        ],
      })).rejects.toMatchObject({ status: 409, code: 'web_name_conflict' });
    }, 30_000);

    it('createEnvironment objects[] 混入非法 host 的 web 对象被拒', async () => {
      const { projectId } = await seedProject(pool);
      const svc = await import('../src/services/environments.service.js');
      await expect(svc.createEnvironment(projectId, {
        name: 'W',
        objects: [
          { objectType: 'db', payload: { host: 'h' } },
          { objectType: 'web', payload: { name: 'web', scheme: 'http' } },
        ],
      })).rejects.toThrow(/host/);
    }, 30_000);

    it('web 登录凭据字段(user/loginUrl/password)类型非法被拒', async () => {
      const { projectId } = await seedProject(pool);
      const svc = await import('../src/services/environments.service.js');
      const env = await svc.createEnvironment(projectId, { name: 'W' });
      await expect(svc.insertEnvironmentObject(env.id, {
        objectType: 'web', payload: { scheme: 'http', host: 'a.com', user: 123 },
      })).rejects.toMatchObject({ status: 400, code: 'invalid_web_credentials' });
      await expect(svc.insertEnvironmentObject(env.id, {
        objectType: 'web', payload: { scheme: 'http', host: 'a.com', password: ['x'] },
      })).rejects.toMatchObject({ status: 400, code: 'invalid_web_credentials' });
    }, 30_000);
  });

  describe('db 对象库型', () => {
    it('dbType 非法值被拒', async () => {
      const { projectId } = await seedProject(pool);
      const svc = await import('../src/services/environments.service.js');
      const env = await svc.createEnvironment(projectId, { name: 'DB' });
      await expect(svc.insertEnvironmentObject(env.id, {
        objectType: 'db', payload: { host: 'h', dbType: 'oracle' },
      })).rejects.toMatchObject({ status: 400, code: 'invalid_db_type' });
    }, 30_000);

    it('dbType 与 url 的 jdbc 库型冲突被拒', async () => {
      const { projectId } = await seedProject(pool);
      const svc = await import('../src/services/environments.service.js');
      const env = await svc.createEnvironment(projectId, { name: 'DB' });
      await expect(svc.insertEnvironmentObject(env.id, {
        objectType: 'db', payload: { host: 'h', dbType: 'postgres', url: 'jdbc:mysql://h:3306/db' },
      })).rejects.toMatchObject({ status: 400, code: 'invalid_db_payload' });
    }, 30_000);

    it('update 保留 prev 的 url(jdbc:…) 证据:表单只带 dbType/host/port/dbName/user 也不会把 url 抹掉', async () => {
      const { projectId } = await seedProject(pool);
      const svc = await import('../src/services/environments.service.js');
      const env = await svc.createEnvironment(projectId, { name: 'DB' });
      const obj = await svc.insertEnvironmentObject(env.id, {
        objectType: 'db',
        payload: { url: 'jdbc:mysql://h:3306/db', host: 'h', port: 3306, dbName: 'db', user: 'u' },
      });
      await svc.updateEnvironmentObject(obj.id, {
        payload: { dbType: 'mysql', host: 'h', port: 3306, dbName: 'db', user: 'u' },
      });
      const raw = (await pool.query(`SELECT payload FROM environment_objects WHERE id=$1`, [obj.id])).rows[0]!.payload as Record<string, unknown>;
      expect(raw.dbType).toBe('mysql');
      expect(raw.url).toBe('jdbc:mysql://h:3306/db');
    }, 30_000);

    it('update 声明了与继承 url 冲突的 dbType → 丢弃过期 url,不报错', async () => {
      const { projectId } = await seedProject(pool);
      const svc = await import('../src/services/environments.service.js');
      const env = await svc.createEnvironment(projectId, { name: 'DB' });
      const obj = await svc.insertEnvironmentObject(env.id, {
        objectType: 'db',
        payload: { url: 'jdbc:mysql://h:3306/db', host: 'h', port: 3306, dbName: 'db', user: 'u' },
      });
      await svc.updateEnvironmentObject(obj.id, {
        payload: { dbType: 'postgres', host: 'h', port: 5432, dbName: 'db', user: 'u' },
      });
      const raw = (await pool.query(`SELECT payload FROM environment_objects WHERE id=$1`, [obj.id])).rows[0]!.payload as Record<string, unknown>;
      expect(raw.dbType).toBe('postgres');
      expect(raw.url).toBeUndefined();
    }, 30_000);

    it('upsert 已有对象时合并 prev 并保留 url', async () => {
      const { projectId } = await seedProject(pool);
      const svc = await import('../src/services/environments.service.js');
      const env = await svc.createEnvironment(projectId, { name: 'DB' });
      await svc.insertEnvironmentObject(env.id, {
        objectType: 'db',
        payload: { url: 'jdbc:mysql://h:3306/db', host: 'h', port: 3306, dbName: 'db', user: 'u' },
      });
      await svc.upsertEnvironmentObject(env.id, { objectType: 'db', payload: { dbType: 'mysql' } });
      const raw = (await pool.query(`SELECT payload FROM environment_objects WHERE environment_id=$1`, [env.id])).rows[0]!.payload as Record<string, unknown>;
      expect(raw.dbType).toBe('mysql');
      expect(raw.url).toBe('jdbc:mysql://h:3306/db');
      expect(raw.host).toBe('h');
    }, 30_000);
  });
});
