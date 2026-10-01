import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { hashSync } from 'bcryptjs';
import { SCHEMA_SQL, SEED_USER_PASSWORD } from './helpers/db.js';

// helpers/auth 依赖 src 服务链（连带加载 db client），须等 DATABASE_URL 指向测试容器后在 beforeAll 动态加载
let authCookie: typeof import('./helpers/auth.js').authCookie;
let memberUserOf: typeof import('./helpers/auth.js').memberUserOf;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

let orgId: string;
let orgPath: string;
let adminId: string;
let plainId: string; // 组织普通成员（非管理员）
let outsiderId: string; // 无任何组织关系
const PLAIN_PASSWORD = 'Plain1234!';

async function createUser(username: string, password: string) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO users(id, username, password_hash, display_name, password_updated_at) VALUES ($1, $2, $3, $4, now())`,
    [id, username, hashSync(password, 4), username],
  );
  return id;
}

async function loginAndGetCookie(username: string, password: string): Promise<string> {
  const r = await request(app).post('/api/auth/login').send({ username, password });
  expect(r.status).toBe(200);
  const c = Array.isArray(r.headers['set-cookie']) ? r.headers['set-cookie'][0]! : r.headers['set-cookie']!;
  return c.split(';')[0]!;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  ({ authCookie, memberUserOf } = await import('./helpers/auth.js'));

  orgId = randomUUID();
  orgPath = `/${orgId}/`;
  await pool.query(`INSERT INTO organizations(id, name, path) VALUES ($1, '成员管理组织', $2)`, [orgId, orgPath]);
  adminId = await createUser('org-admin', SEED_USER_PASSWORD);
  await pool.query(`INSERT INTO organization_members(organization_id, user_id, is_manager, is_user) VALUES ($1, $2, true, true)`, [orgId, adminId]);
  plainId = await createUser('plain-member', PLAIN_PASSWORD);
  await pool.query(`INSERT INTO organization_members(organization_id, user_id, is_manager, is_user) VALUES ($1, $2, false, true)`, [orgId, plainId]);
  outsiderId = await createUser('outsider', SEED_USER_PASSWORD);

  const { default: express } = await import('express');
  const { authRoute } = await import('../src/routes/auth.js');
  const { organizationsRoute } = await import('../src/routes/organizations.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  app.use('/api/auth', authRoute);
  app.use('/api/organizations', organizationsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

describe('GET /api/organizations 可见组织', () => {
  it('管理员可见自己组织 + 管理的子树', async () => {
    const cookie = await loginAndGetCookie('org-admin', SEED_USER_PASSWORD);
    const r = await request(app).get('/api/organizations').set('Cookie', cookie);
    expect(r.status).toBe(200);
    const mine = r.body.find((o: { id: string }) => o.id === orgId);
    expect(mine.isManager).toBe(true);
    expect(mine.memberCount).toBe(2);
  });

  it('普通成员只看到自己加入的组织（不含管理子树新增组织）', async () => {
    const cookie = authCookie(memberUserOf(plainId, 'plain-member', orgId, orgPath));
    const r = await request(app).get('/api/organizations').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0].id).toBe(orgId);
    expect(r.body[0].isManager).toBe(false);
  });

  it('无 cookie → 401', async () => {
    expect((await request(app).get('/api/organizations')).status).toBe(401);
  });
});

describe('POST /api/organizations 创建子组织', () => {
  it('管理员创建 → path = 父路径 + 自身 id', async () => {
    const cookie = await loginAndGetCookie('org-admin', SEED_USER_PASSWORD);
    const r = await request(app).post('/api/organizations').set('Cookie', cookie).send({ name: '研发部', parentId: orgId });
    expect(r.status).toBe(201);
    expect(r.body.parentId).toBe(orgId);
    expect(r.body.path).toBe(`${orgPath}${r.body.id}/`);

    // 管理子树扩展：管理员可见新子组织
    const list = await request(app).get('/api/organizations').set('Cookie', cookie);
    expect(list.body.some((o: { id: string }) => o.id === r.body.id)).toBe(true);
  });

  it('普通成员 → 403', async () => {
    const cookie = authCookie(memberUserOf(plainId, 'plain-member', orgId, orgPath));
    const r = await request(app).post('/api/organizations').set('Cookie', cookie).send({ name: '偷偷建', parentId: orgId });
    expect(r.status).toBe(403);
  });

  it('父组织不存在 → 404', async () => {
    const cookie = await loginAndGetCookie('org-admin', SEED_USER_PASSWORD);
    const r = await request(app).post('/api/organizations').set('Cookie', cookie).send({ name: 'x', parentId: randomUUID() });
    expect(r.status).toBe(404);
  });
});

describe('组织成员管理', () => {
  let adminCookie: string;
  let subOrgId: string;

  beforeAll(async () => {
    adminCookie = await loginAndGetCookie('org-admin', SEED_USER_PASSWORD);
    const r = await request(app).post('/api/organizations').set('Cookie', adminCookie).send({ name: '成员管理用子组织', parentId: orgId });
    subOrgId = r.body.id;
  });

  it('非管理员添加成员 → 403', async () => {
    const plainCookie = authCookie(memberUserOf(plainId, 'plain-member', orgId, orgPath));
    const r = await request(app).post(`/api/organizations/${subOrgId}/members`).set('Cookie', plainCookie).send({ username: 'outsider' });
    expect(r.status).toBe(403);
  });

  it('添加不存在的用户 → 404', async () => {
    const r = await request(app).post(`/api/organizations/${subOrgId}/members`).set('Cookie', adminCookie).send({ username: 'ghost-user' });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('not_found');
  });

  it('按 username 添加成员 → 201；重复 → 409', async () => {
    const r = await request(app).post(`/api/organizations/${subOrgId}/members`).set('Cookie', adminCookie).send({ username: 'outsider' });
    expect(r.status).toBe(201);

    const dup = await request(app).post(`/api/organizations/${subOrgId}/members`).set('Cookie', adminCookie).send({ username: 'outsider' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('already_member');
  });

  it('成员列表含 username/角色', async () => {
    const r = await request(app).get(`/api/organizations/${subOrgId}/members`).set('Cookie', adminCookie);
    expect(r.status).toBe(200);
    const outsider = r.body.items.find((m: { username: string }) => m.username === 'outsider');
    expect(outsider).toBeTruthy();
    expect(outsider.isManager).toBe(false);
    expect(outsider.isUser).toBe(true);
  });

  it('组织外的普通成员读成员列表 → 404（不泄露存在性）', async () => {
    const plainCookie = authCookie(memberUserOf(plainId, 'plain-member', orgId, orgPath));
    // plain 是父组织成员但不是子组织成员，且非管理员 → 404
    const r = await request(app).get(`/api/organizations/${subOrgId}/members`).set('Cookie', plainCookie);
    expect(r.status).toBe(404);
  });

  it('切换角色 PATCH → isManager 更新', async () => {
    const r = await request(app).patch(`/api/organizations/${subOrgId}/members/${outsiderId}`).set('Cookie', adminCookie).send({ isManager: true });
    expect(r.status).toBe(200);
    const list = await request(app).get(`/api/organizations/${subOrgId}/members`).set('Cookie', adminCookie);
    expect(list.body.items.find((m: { userId: string }) => m.userId === outsiderId).isManager).toBe(true);
  });

  it('不能移除自己 → 409', async () => {
    const r = await request(app).delete(`/api/organizations/${subOrgId}/members/${adminId}`).set('Cookie', adminCookie);
    expect(r.status).toBe(409);
  });

  it('不能移除最后一个成员资格 → 409', async () => {
    // outsider 只有 subOrg 一个成员资格
    const r = await request(app).delete(`/api/organizations/${subOrgId}/members/${outsiderId}`).set('Cookie', adminCookie);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('last_membership');
  });

  it('移除成员（多组织用户）→ 200', async () => {
    // plain-member 有两个组织（父 + 子）→ 移除子组织成员资格应成功
    const add = await request(app).post(`/api/organizations/${subOrgId}/members`).set('Cookie', adminCookie).send({ username: 'plain-member' });
    expect(add.status).toBe(201);
    const r = await request(app).delete(`/api/organizations/${subOrgId}/members/${plainId}`).set('Cookie', adminCookie);
    expect(r.status).toBe(200);
    const list = await request(app).get(`/api/organizations/${subOrgId}/members`).set('Cookie', adminCookie);
    expect(list.body.items.some((m: { userId: string }) => m.userId === plainId)).toBe(false);
  });

  it('移除非成员 → 404', async () => {
    const ghost = await createUser('ghost-remove', SEED_USER_PASSWORD);
    const r = await request(app).delete(`/api/organizations/${subOrgId}/members/${ghost}`).set('Cookie', adminCookie);
    expect(r.status).toBe(404);
  });
});
