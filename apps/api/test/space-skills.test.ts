import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let managerApp: import('express').Express;
let memberApp: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: exp } = await import('express');
  const { spaceRoute } = await import('../src/pi/space/router.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  const { managerUserOf, memberUserOf } = await import('./helpers/auth.js');
  const mount = (user: ReturnType<typeof managerUserOf>) => {
    const a = exp();
    a.use(exp.json());
    a.use((req, _res, next) => { req.user = user; next(); });
    a.use('/api/assistant', spaceRoute);
    a.use(errorHandler);
    return a;
  };
  managerApp = mount(managerUserOf(userId, username, orgId, orgPath));
  memberApp = mount(memberUserOf(userId, username, orgId, orgPath));
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE assistant_skills`);
});

const SKILL_BODY = '# 测试技能\n\n用于跑冒烟.';

describe('S4 skills 全局共享 CRUD：校验 + 鉴权', () => {
  it('POST 建 skill（scripts 缺省 []）；name slug 校验与重名 409', async () => {
    const ok = await request(managerApp).post('/api/assistant/skills')
      .send({ name: 'smoke-check', description: '冒烟技能', body: SKILL_BODY });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ name: 'smoke-check', description: '冒烟技能', body: SKILL_BODY, scripts: [], enabled: true });
    // 重名 → 409（全局唯一）
    expect((await request(managerApp).post('/api/assistant/skills')
      .send({ name: 'smoke-check', description: 'dup', body: SKILL_BODY })).status).toBe(409);
    // slug 非法：大写/前导 _-/空/中文
    expect((await request(managerApp).post('/api/assistant/skills')
      .send({ name: 'Bad_Name', description: 'x', body: SKILL_BODY })).status).toBe(400);
    expect((await request(managerApp).post('/api/assistant/skills')
      .send({ name: '-lead', description: 'x', body: SKILL_BODY })).status).toBe(400);
    expect((await request(managerApp).post('/api/assistant/skills')
      .send({ description: 'x', body: SKILL_BODY })).status).toBe(400);
    // 缺 description / body
    expect((await request(managerApp).post('/api/assistant/skills')
      .send({ name: 'nd', body: SKILL_BODY })).status).toBe(400);
    expect((await request(managerApp).post('/api/assistant/skills')
      .send({ name: 'nb', description: 'x' })).status).toBe(400);
  });

  it('scripts 校验：非法 runtime / 文件名逃逸 / 非数组 → 400', async () => {
    const base = { name: 's', description: 'x', body: SKILL_BODY };
    expect((await request(managerApp).post('/api/assistant/skills')
      .send({ ...base, scripts: [{ filename: 'a.js', runtime: 'perl', content: '#' }] })).status).toBe(400);
    expect((await request(managerApp).post('/api/assistant/skills')
      .send({ ...base, scripts: [{ filename: '../a.js', runtime: 'node', content: '#' }] })).status).toBe(400);
    expect((await request(managerApp).post('/api/assistant/skills')
      .send({ ...base, scripts: [{ filename: '/etc/a.js', runtime: 'node', content: '#' }] })).status).toBe(400);
    expect((await request(managerApp).post('/api/assistant/skills')
      .send({ ...base, scripts: [{ filename: '.hidden', runtime: 'node', content: '#' }] })).status).toBe(400);
    expect((await request(managerApp).post('/api/assistant/skills')
      .send({ ...base, scripts: 'not-array' })).status).toBe(400);
    // 合法含目录穿越埋点文件名 → 201
    const ok = await request(managerApp).post('/api/assistant/skills')
      .send({ ...base, name: 'with-script', scripts: [{ filename: 'a.js', runtime: 'node', content: 'console.log(1)' }] });
    expect(ok.status).toBe(201);
    expect(ok.body.scripts).toEqual([{ filename: 'a.js', runtime: 'node', content: 'console.log(1)' }]);
  });

  it('GET：全量按 name 排序；enabled 过滤', async () => {
    await request(managerApp).post('/api/assistant/skills').send({ name: 'b', description: 'x', body: SKILL_BODY });
    await request(managerApp).post('/api/assistant/skills').send({ name: 'a', description: 'x', body: SKILL_BODY });
    await request(managerApp).post('/api/assistant/skills').send({ name: 'z-off', description: 'x', body: SKILL_BODY, enabled: false });
    const all = await request(managerApp).get('/api/assistant/skills');
    expect(all.status).toBe(200);
    expect(all.body.map((s: { name: string }) => s.name)).toEqual(['a', 'b', 'z-off']);
    const on = await request(managerApp).get('/api/assistant/skills?enabled=true');
    expect(on.body.map((s: { name: string }) => s.name)).toEqual(['a', 'b']);
    const off = await request(managerApp).get('/api/assistant/skills?enabled=false');
    expect(off.body.map((s: { name: string }) => s.name)).toEqual(['z-off']);
  });

  it('PATCH：改 body/scripts/enabled；重名改名 → 409；不存在 → 404', async () => {
    const created = await request(managerApp).post('/api/assistant/skills')
      .send({ name: 'editable', description: 'x', body: SKILL_BODY });
    const id = created.body.id as string;
    const patched = await request(managerApp).patch(`/api/assistant/skills/${id}`)
      .send({ description: 'y', scripts: [{ filename: 't.py', runtime: 'python3', content: 'print(1)' }], enabled: false });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ description: 'y', enabled: false });
    expect(patched.body.scripts).toEqual([{ filename: 't.py', runtime: 'python3', content: 'print(1)' }]);
    // 改名撞已有 → 409
    await request(managerApp).post('/api/assistant/skills').send({ name: 'taken', description: 'x', body: SKILL_BODY });
    expect((await request(managerApp).patch(`/api/assistant/skills/${id}`).send({ name: 'taken' })).status).toBe(409);
    // 改名到新名 → 200（排除自身）
    expect((await request(managerApp).patch(`/api/assistant/skills/${id}`).send({ name: 'renamed' })).status).toBe(200);
    expect((await request(managerApp).patch(`/api/assistant/skills/${randomUUID()}`).send({ enabled: true })).status).toBe(404);
    expect((await request(managerApp).patch(`/api/assistant/skills/${id}`).send({ body: '' })).status).toBe(400);
  });

  it('DELETE：删除返回 204；再删/不存在 → 404', async () => {
    const created = await request(managerApp).post('/api/assistant/skills')
      .send({ name: 'gone', description: 'x', body: SKILL_BODY });
    const id = created.body.id as string;
    expect((await request(managerApp).delete(`/api/assistant/skills/${id}`)).status).toBe(204);
    expect((await request(managerApp).get('/api/assistant/skills')).body.length).toBe(0);
    expect((await request(managerApp).delete(`/api/assistant/skills/${id}`)).status).toBe(404);
  });

  it('member 一律 403', async () => {
    expect((await request(memberApp).post('/api/assistant/skills')
      .send({ name: 'x', description: 'x', body: SKILL_BODY })).status).toBe(403);
    expect((await request(memberApp).get('/api/assistant/skills')).status).toBe(403);
    expect((await request(memberApp).patch('/api/assistant/skills/x').send({ enabled: true })).status).toBe(403);
    expect((await request(memberApp).delete('/api/assistant/skills/x')).status).toBe(403);
  });
});