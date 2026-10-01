import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { hashSync } from 'bcryptjs';
import { SCHEMA_SQL, SEED_USER_PASSWORD } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

// 组织 + 两个用户：manager（正常密码）/ target（首登强制改密）
let orgId: string;
let orgPath: string;
let managerId: string;
let targetId: string;
const TARGET_INIT_PASSWORD = 'InitPass123!';

async function createUser(username: string, password: string, opts: { mustChange?: boolean } = {}) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO users(id, username, password_hash, display_name, must_change_password, password_updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, username, hashSync(password, 4), username, opts.mustChange ? true : false, opts.mustChange ? null : new Date()],
  );
  return id;
}

function cookieFrom(res: request.Response): string {
  const setCookie = res.headers['set-cookie'];
  expect(setCookie).toBeTruthy();
  const c = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
  return c.split(';')[0]!;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);

  orgId = randomUUID();
  orgPath = `/${orgId}/`;
  await pool.query(`INSERT INTO organizations(id, name, path) VALUES ($1, '主组织', $2)`, [orgId, orgPath]);
  managerId = await createUser('manager1', SEED_USER_PASSWORD);
  await pool.query(`INSERT INTO organization_members(organization_id, user_id, is_manager, is_user) VALUES ($1, $2, true, true)`, [orgId, managerId]);
  targetId = await createUser('target1', TARGET_INIT_PASSWORD, { mustChange: true });
  await pool.query(`INSERT INTO organization_members(organization_id, user_id, is_manager, is_user) VALUES ($1, $2, false, true)`, [orgId, targetId]);

  const { default: express } = await import('express');
  const { authRoute } = await import('../src/routes/auth.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  app.use('/api/auth', authRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

describe('POST /api/auth/login', () => {
  it('密码错误 → 401', async () => {
    const r = await request(app).post('/api/auth/login').send({ username: 'manager1', password: 'wrong-pass' });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('invalid_credentials');
  });

  it('用户不存在 → 401（与密码错误同文案）', async () => {
    const r = await request(app).post('/api/auth/login').send({ username: 'no-such-user', password: 'whatever123!' });
    expect(r.status).toBe(401);
    expect(r.body.message).toBe('用户名或密码错误');
  });

  it('登录成功 → Set-Cookie（HttpOnly/SameSite=strict）+ user', async () => {
    const r = await request(app).post('/api/auth/login').send({ username: 'manager1', password: SEED_USER_PASSWORD });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ok');
    expect(r.body.user.username).toBe('manager1');
    expect(r.body.organization.id).toBe(orgId);
    expect(r.body.user.passwordHash).toBeUndefined();
    const c = Array.isArray(r.headers['set-cookie']) ? r.headers['set-cookie'][0]! : r.headers['set-cookie']!;
    expect(c).toContain('authToken=');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Strict');
  });
});

describe('强制改密流程', () => {
  it('must_change_password 用户登录 → password_change_required', async () => {
    const r = await request(app).post('/api/auth/login').send({ username: 'target1', password: TARGET_INIT_PASSWORD });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('password_change_required');
    expect(r.body.passwordChangeToken).toBeTruthy();
    expect(r.body.username).toBe('target1');
  });

  it('弱密码 → 400 weak_password', async () => {
    const login = await request(app).post('/api/auth/login').send({ username: 'target1', password: TARGET_INIT_PASSWORD });
    const r = await request(app).post('/api/auth/change-password').send({
      passwordChangeToken: login.body.passwordChangeToken,
      newPassword: 'short',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('weak_password');
  });

  it('改密成功 → 自动登录发 cookie；旧密码失效、新密码可登录', async () => {
    const login = await request(app).post('/api/auth/login').send({ username: 'target1', password: TARGET_INIT_PASSWORD });
    const newPassword = 'NewPass456!';
    const r = await request(app).post('/api/auth/change-password').send({
      passwordChangeToken: login.body.passwordChangeToken,
      newPassword,
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ok');

    const oldLogin = await request(app).post('/api/auth/login').send({ username: 'target1', password: TARGET_INIT_PASSWORD });
    expect(oldLogin.status).toBe(401);

    const relogin = await request(app).post('/api/auth/login').send({ username: 'target1', password: newPassword });
    expect(relogin.status).toBe(200);
    expect(relogin.body.status).toBe('ok');

    // token 过期复用：旧 passwordChangeToken 已一次性消耗（用户 tokenVersion 已变，且登录不再要求改密）
    const reuse = await request(app).post('/api/auth/change-password').send({
      passwordChangeToken: login.body.passwordChangeToken,
      newPassword: 'Another789!',
    });
    expect(reuse.status).toBe(401);
  });
});

describe('GET /api/auth/me', () => {
  it('无 cookie → 401', async () => {
    const r = await request(app).get('/api/auth/me');
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('unauthorized');
  });

  it('带 cookie → user + organizations', async () => {
    const login = await request(app).post('/api/auth/login').send({ username: 'manager1', password: SEED_USER_PASSWORD });
    const cookie = cookieFrom(login);
    const r = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.user.username).toBe('manager1');
    expect(r.body.activeOrganizationId).toBe(orgId);
    expect(r.body.organizations).toHaveLength(1);
    expect(r.body.organizations[0].path).toBe(orgPath);
    expect(r.body.organizations[0].isManager).toBe(true);
  });

  it('伪造 token → 401', async () => {
    const r = await request(app).get('/api/auth/me').set('Cookie', 'authToken=forged.token.value');
    expect(r.status).toBe(401);
  });
});

describe('POST /api/auth/switch-org', () => {
  it('非成员 → 403', async () => {
    const otherOrg = randomUUID();
    await pool.query(`INSERT INTO organizations(id, name, path) VALUES ($1, '别的组织', $2)`, [otherOrg, `/${otherOrg}/`]);
    const login = await request(app).post('/api/auth/login').send({ username: 'target1', password: 'NewPass456!' });
    const r = await request(app).post('/api/auth/switch-org').set('Cookie', cookieFrom(login)).send({ organizationId: otherOrg });
    expect(r.status).toBe(403);
  });

  it('成员切换 → 200，/me 激活组织更新', async () => {
    const subOrg = randomUUID();
    await pool.query(`INSERT INTO organizations(id, name, parent_id, path) VALUES ($1, '子组织', $2, $3)`, [
      subOrg,
      orgId,
      `${orgPath}${subOrg}/`,
    ]);
    await pool.query(`INSERT INTO organization_members(organization_id, user_id, is_manager, is_user) VALUES ($1, $2, true, true)`, [subOrg, managerId]);

    const login = await request(app).post('/api/auth/login').send({ username: 'manager1', password: SEED_USER_PASSWORD });
    const cookie = cookieFrom(login);
    const r = await request(app).post('/api/auth/switch-org').set('Cookie', cookie).send({ organizationId: subOrg });
    expect(r.status).toBe(200);
    expect(r.body.organization.id).toBe(subOrg);

    const me = await request(app).get('/api/auth/me').set('Cookie', cookieFrom(r));
    expect(me.body.activeOrganizationId).toBe(subOrg);
  });
});

describe('登出与 tokenVersion 吊销', () => {
  it('logout 后旧 cookie 立即 401', async () => {
    const login = await request(app).post('/api/auth/login').send({ username: 'manager1', password: SEED_USER_PASSWORD });
    const cookie = cookieFrom(login);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(200);

    const out = await request(app).post('/api/auth/logout').set('Cookie', cookie);
    expect(out.status).toBe(200);
    expect(out.body.ok).toBe(true);

    const after = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(after.status).toBe(401);
  });
});

describe('PATCH /api/auth/me/password 自助改密', () => {
  it('当前密码错 → 400', async () => {
    const login = await request(app).post('/api/auth/login').send({ username: 'target1', password: 'NewPass456!' });
    const r = await request(app)
      .patch('/api/auth/me/password')
      .set('Cookie', cookieFrom(login))
      .send({ currentPassword: 'wrong!', newPassword: 'Whatever123!' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('wrong_password');
  });

  it('改密成功 → 旧会话吊销、需用新密码登录', async () => {
    const login = await request(app).post('/api/auth/login').send({ username: 'target1', password: 'NewPass456!' });
    const cookie = cookieFrom(login);
    const r = await request(app)
      .patch('/api/auth/me/password')
      .set('Cookie', cookie)
      .send({ currentPassword: 'NewPass456!', newPassword: 'FinalPass789!' });
    expect(r.status).toBe(200);

    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
    const relogin = await request(app).post('/api/auth/login').send({ username: 'target1', password: 'FinalPass789!' });
    expect(relogin.status).toBe(200);
  });
});

describe('tokenVersion 服务端吊销', () => {
  it('直接铸的 token 在 DB tokenVersion 不匹配时被拒', async () => {
    // 手工把 manager1 的 tokenVersion +1，模拟其他设备登出
    await pool.query(`UPDATE users SET token_version = token_version + 1 WHERE id = $1`, [managerId]);
    const login = await request(app).post('/api/auth/login').send({ username: 'manager1', password: SEED_USER_PASSWORD });
    const cookie = cookieFrom(login);
    // 登录后的 token 与最新 tokenVersion 一致 → 可用
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(200);
    // 再次 +1 → 旧 token 失效
    await pool.query(`UPDATE users SET token_version = token_version + 1 WHERE id = $1`, [managerId]);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
  });
});
