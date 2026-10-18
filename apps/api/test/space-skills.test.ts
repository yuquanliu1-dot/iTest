import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let managerApp: import('express').Express;
let memberApp: import('express').Express;
/** 隔离的 .data 根：必须在任何静态/动态 import skillsStore 之前设好，否则模块级 SKILLS_ROOT
 *  会解析到开发者真实的 PI_DATA_DIR，测试会真的建删目录。 */
let tmpDataDir: string;

const skillsRoot = (): string => path.join(tmpDataDir, 'skills');
const skillDir = (name: string): string => path.join(skillsRoot(), name);

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  tmpDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'itest-skilldata-'));
  process.env.PI_DATA_DIR = tmpDataDir;
  vi.resetModules();
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
  await fs.promises.rm(tmpDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await pool.query('TRUNCATE assistant_skills');
  await fs.promises.rm(skillsRoot(), { recursive: true, force: true });
});

describe('skills 元数据 CRUD（文件系统为真源）', () => {
  it('POST 建目录 + SKILL.md 骨架 + DB 行', async () => {
    const ok = await request(managerApp).post('/api/assistant/skills')
      .send({ name: 'smoke-check', description: '冒烟技能' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ name: 'smoke-check', description: '冒烟技能', enabled: true, onDisk: true });
    const md = path.join(skillDir('smoke-check'), 'SKILL.md');
    expect(fs.existsSync(md)).toBe(true);
    expect(fs.readFileSync(md, 'utf8')).toContain('name: "smoke-check"');
    expect(ok.body.fileCount).toBe(1); // 只有 SKILL.md
  });

  it('name slug 校验 + 重名 409 + 缺 description 400', async () => {
    await request(managerApp).post('/api/assistant/skills').send({ name: 'dup', description: 'd' });
    expect((await request(managerApp).post('/api/assistant/skills').send({ name: 'dup', description: 'd2' })).status).toBe(409);
    expect((await request(managerApp).post('/api/assistant/skills').send({ name: 'Bad_Name', description: 'x' })).status).toBe(400);
    expect((await request(managerApp).post('/api/assistant/skills').send({ name: '-lead', description: 'x' })).status).toBe(400);
    expect((await request(managerApp).post('/api/assistant/skills').send({ name: 'nd' })).status).toBe(400);
  });

  it('GET：全量按 name 排序；enabled 过滤', async () => {
    for (const [name, enabled] of [['b', true], ['a', true], ['z-off', false]] as const) {
      await request(managerApp).post('/api/assistant/skills').send({ name, description: 'x', enabled });
    }
    const all = await request(managerApp).get('/api/assistant/skills');
    expect(all.status).toBe(200);
    expect(all.body.map((s: { name: string }) => s.name)).toEqual(['a', 'b', 'z-off']);
    expect((await request(managerApp).get('/api/assistant/skills?enabled=true'))
      .body.map((s: { name: string }) => s.name)).toEqual(['a', 'b']);
    expect((await request(managerApp).get('/api/assistant/skills?enabled=false'))
      .body.map((s: { name: string }) => s.name)).toEqual(['z-off']);
  });

  it('PATCH 改名 → 目录跟着搬', async () => {
    const created = await request(managerApp).post('/api/assistant/skills').send({ name: 'old-name', description: 'x' });
    const id = created.body.id as string;
    const patched = await request(managerApp).patch(`/api/assistant/skills/${id}`).send({ name: 'new-name', description: 'y' });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ name: 'new-name', description: 'y', onDisk: true });
    expect(fs.existsSync(skillDir('old-name'))).toBe(false);
    expect(fs.existsSync(path.join(skillDir('new-name'), 'SKILL.md'))).toBe(true);
  });

  it('PATCH 改 enabled/description；改名撞已有 409；不存在 404；空 description 400', async () => {
    const created = await request(managerApp).post('/api/assistant/skills').send({ name: 'editable', description: 'x' });
    const id = created.body.id as string;
    const patched = await request(managerApp).patch(`/api/assistant/skills/${id}`).send({ description: 'y', enabled: false });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ description: 'y', enabled: false });
    await request(managerApp).post('/api/assistant/skills').send({ name: 'taken', description: 'x' });
    expect((await request(managerApp).patch(`/api/assistant/skills/${id}`).send({ name: 'taken' })).status).toBe(409);
    expect((await request(managerApp).patch(`/api/assistant/skills/${randomUUID()}`).send({ enabled: true })).status).toBe(404);
    expect((await request(managerApp).patch(`/api/assistant/skills/${id}`).send({ description: '' })).status).toBe(400);
  });

  it('DELETE：DB 行与磁盘目录一起没；再删 404', async () => {
    const created = await request(managerApp).post('/api/assistant/skills').send({ name: 'gone', description: 'x' });
    const id = created.body.id as string;
    expect((await request(managerApp).delete(`/api/assistant/skills/${id}`)).status).toBe(204);
    expect(fs.existsSync(skillDir('gone'))).toBe(false);
    expect((await request(managerApp).get('/api/assistant/skills')).body.length).toBe(0);
    expect((await request(managerApp).delete(`/api/assistant/skills/${id}`)).status).toBe(404);
  });

  it('GET：孤儿目录以 unregistered 行出现，绝不入 enabled 过滤结果', async () => {
    await request(managerApp).post('/api/assistant/skills').send({ name: 'counted', description: 'x' });
    fs.mkdirSync(path.join(skillDir('counted'), 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(skillDir('counted'), 'scripts', 'a.py'), 'print(1)');
    fs.mkdirSync(skillDir('orphan-dir'), { recursive: true });
    fs.writeFileSync(path.join(skillDir('orphan-dir'), 'SKILL.md'), 'x');

    const all = await request(managerApp).get('/api/assistant/skills');
    const counted = all.body.find((s: { name: string }) => s.name === 'counted');
    expect(counted.fileCount).toBe(2); // SKILL.md + scripts/a.py
    const orphan = all.body.find((s: { name: string }) => s.name === 'orphan-dir');
    expect(orphan.unregistered).toBe(true);
    expect(orphan.id).toBeNull();
    expect((await request(managerApp).get('/api/assistant/skills?enabled=true'))
      .body.map((s: { name: string }) => s.name)).toEqual(['counted']);
  });

  it('member 一律 403', async () => {
    expect((await request(memberApp).post('/api/assistant/skills').send({ name: 'x', description: 'x' })).status).toBe(403);
    expect((await request(memberApp).get('/api/assistant/skills')).status).toBe(403);
    expect((await request(memberApp).patch('/api/assistant/skills/x').send({ enabled: true })).status).toBe(403);
    expect((await request(memberApp).delete('/api/assistant/skills/x')).status).toBe(403);
  });
});
