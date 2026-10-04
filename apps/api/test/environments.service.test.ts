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
    const env = await svc.createEnvironment(projectId, { name: '生产', baseUrl: 'https://prod.example.com' });
    await svc.insertEnvironmentObject(env.id, { objectType: 'db', payload: { host: 'h', dbName: 'd', user: 'u', password: 'SUPER-SECRET' }, isDefault: true });
    await expect(svc.createEnvironment(projectId, { name: '生产' })).rejects.toMatchObject({ status: 409, code: 'name_conflict' });

    const list = await svc.listEnvironments(projectId);
    expect(list).toHaveLength(1);
    expect(list[0]!.objects).toHaveLength(1);
    expect(JSON.stringify(list[0]!.objects)).not.toContain('SUPER-SECRET');
    expect(JSON.stringify(list[0]!.objects)).toContain('••••••••');
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

  it('login 对象:密码加密进 secret,user/loginUrl 明文;留空沿用旧密文;入参 secret 丢弃', async () => {
    const { projectId } = await seedProject(pool);
    const svc = await import('../src/services/environments.service.js');
    const env = await svc.createEnvironment(projectId, { name: 'L' });
    const obj = await svc.insertEnvironmentObject(env.id, {
      objectType: 'login',
      payload: { user: 'tom', loginUrl: 'https://x.example.com/login', password: 'LOGIN-PASS' },
      isDefault: true,
    });
    // 出参脱敏,明文字段保留
    expect((obj.payload as { user: string }).user).toBe('tom');
    expect((obj.payload as { loginUrl: string }).loginUrl).toBe('https://x.example.com/login');
    expect((obj.payload as { secret: string }).secret).toBe('••••••••');
    const raw = (await pool.query(`SELECT payload FROM environment_objects WHERE id=$1`, [obj.id])).rows[0]!.payload as { secret?: { c?: string } };
    expect(JSON.stringify(raw)).not.toContain('LOGIN-PASS');
    expect(raw.secret?.c).toBeTruthy();

    // 更新不带密码 → 旧密文沿用;入参 secret 一律丢弃
    const before = raw.secret!.c;
    const up = await svc.updateEnvironmentObject(obj.id, {
      payload: { user: 'jerry', loginUrl: 'https://x.example.com/login', secret: 'evil-plain' } as Record<string, unknown>,
    });
    expect((up.payload as { user: string }).user).toBe('jerry');
    const raw2 = (await pool.query(`SELECT payload FROM environment_objects WHERE id=$1`, [obj.id])).rows[0]!.payload as { secret?: { c?: string } };
    expect(raw2.secret?.c).toBeTruthy();
    expect(raw2.secret!.c).not.toContain('evil-plain');
    // 密钥未变 → 密文不变（沿用而非重新加密）
    expect(raw2.secret!.c).toBe(before);
  }, 30_000);
});
