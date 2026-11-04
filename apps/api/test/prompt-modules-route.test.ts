/** prompt 模块路由：列表/版本链/直改/回滚/skill 只读组守卫/权限门。 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import type { Express } from 'express';
import request from 'supertest';
import { SCHEMA_SQL, seedOrg } from './helpers/db.js';
// auth helpers 不能静态 import：auth.service → db/client 在模块加载期即固化
// DATABASE_URL，会把应用 db 指到 beforeAll 设 env 之前的库（space-skills 同款坑）。
let managerUserOf: typeof import('./helpers/auth.js').managerUserOf;
let memberUserOf: typeof import('./helpers/auth.js').memberUserOf;

let pool: Pool;
let tmpDataDir: string;
let orgId = '';
let orgPath = '';
let orgUserId = '';
let orgUsername = '';
let mount: (role: 'manager' | 'member') => Promise<Express>;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  const org = await seedOrg(pool);
  orgId = org.orgId;
  orgPath = org.orgPath;
  orgUserId = org.userId;
  orgUsername = org.username;
  tmpDataDir = mkdtempSync(join(tmpdir(), 'itest-pmr-'));
  process.env.PI_DATA_DIR = tmpDataDir;
  ({ managerUserOf, memberUserOf } = await import('./helpers/auth.js'));
  const { spaceRoute } = await import('../src/pi/space/router.js');
  const express = (await import('express')).default;
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  mount = async (role) => {
    // manager 用 seedOrg 落库的真实 userId：路由写 created_by_user_id 有 FK 约束；
    // member 只走 403（requireManager 拒在 handler 前），随机 id 无插入、不触 FK。
    const user = role === 'manager'
      ? managerUserOf(orgUserId, orgUsername, orgId, orgPath)
      : memberUserOf(crypto.randomUUID(), 'mem', orgId, orgPath);
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use((req, _res, next) => { req.user = user; next(); });
    app.use('/api/assistant', spaceRoute);
    app.use(errorHandler);
    return app;
  };
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await pool.query(`TRUNCATE assistant_prompt_module_versions, assistant_skills`);
});

async function seedSkill(name = 'demo-skill') {
  await pool.query(`INSERT INTO assistant_skills (name, description) VALUES ($1, '演示技能')`, [name]);
  const dir = join(tmpDataDir, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${JSON.stringify(name)}\ndescription: "演示技能"\n---\n\n旧正文`);
}

describe('prompt-modules 路由', () => {
  it('GET 列表：无行 isDefault=true；写值后 hasRow/isDefault=false/source=manual_edit', async () => {
    const app = await mount('manager');
    const before = await request(app).get('/api/assistant/prompt-modules').expect(200);
    const styleZh = before.body.find((m: { key: string }) => m.key === 'space.style.zh');
    expect(styleZh.isDefault).toBe(true);

    await request(app).post('/api/assistant/prompt-modules/space.style.zh/value')
      .send({ value: '新风格文案' }).expect(200);

    const after = await request(app).get('/api/assistant/prompt-modules').expect(200);
    const row = after.body.find((m: { key: string }) => m.key === 'space.style.zh');
    expect(row.isDefault).toBe(false);
    expect(row.hasRow).toBe(true);
    expect(row.source).toBe('manual_edit');
    expect(row.text).toBe('新风格文案');
  });

  it('POST value=null（恢复默认）：落 NULL 行，isDefault 回 true', async () => {
    const app = await mount('manager');
    await request(app).post('/api/assistant/prompt-modules/space.style.zh/value').send({ value: 'x' }).expect(200);
    await request(app).post('/api/assistant/prompt-modules/space.style.zh/value').send({ value: null }).expect(200);
    const list = await request(app).get('/api/assistant/prompt-modules').expect(200);
    const row = list.body.find((m: { key: string }) => m.key === 'space.style.zh');
    expect(row.isDefault).toBe(true);
    expect(row.hasRow).toBe(true); // 行在，值 NULL=跟随代码默认
  });

  it('POST fromSeq 回滚：复制历史行 value，source=rollback', async () => {
    const app = await mount('manager');
    const r1 = await request(app).post('/api/assistant/prompt-modules/space.style.zh/value').send({ value: '第一版' }).expect(200);
    await request(app).post('/api/assistant/prompt-modules/space.style.zh/value').send({ value: '第二版' }).expect(200);
    await request(app).post(`/api/assistant/prompt-modules/space.style.zh/value`).send({ fromSeq: r1.body.seq }).expect(200);
    const vers = await request(app).get('/api/assistant/prompt-modules/space.style.zh/versions').expect(200);
    expect(vers.body.length).toBe(3);
    expect(vers.body[0].value).toBe('第一版');
    expect(vers.body[0].source).toBe('rollback');
  });

  it('POST fromSeq 不存在的版本行 → 404', async () => {
    const app = await mount('manager');
    await request(app).post('/api/assistant/prompt-modules/space.style.zh/value').send({ fromSeq: 999999 }).expect(404);
  });

  it('未知 key → 404；空白值 → 400', async () => {
    const app = await mount('manager');
    await request(app).post('/api/assistant/prompt-modules/nope.x/value').send({ value: 'x' }).expect(404);
    await request(app).post('/api/assistant/prompt-modules/space.style.zh/value').send({ value: '   ' }).expect(400);
  });

  it('skill 只读组：value 直改 → 400；fromSeq 回滚 → 200 且写回磁盘', async () => {
    await seedSkill();
    const app = await mount('manager');
    await request(app).post('/api/assistant/prompt-modules/skill.demo-skill/value').send({ value: 'hack' }).expect(400);

    // 造历史行：先经 baseline 语义手工插两行（模拟已有版本链）
    await pool.query(`INSERT INTO assistant_prompt_module_versions (module_key, value, source) VALUES ('skill.demo-skill', '旧正文', 'baseline')`);
    await pool.query(`INSERT INTO assistant_prompt_module_versions (module_key, value, source) VALUES ('skill.demo-skill', '新正文', 'solidify_apply')`);
    const vers = await request(app).get('/api/assistant/prompt-modules/skill.demo-skill/versions').expect(200);
    const baselineSeq = vers.body.find((v: { source: string }) => v.source === 'baseline').seq;

    await request(app).post('/api/assistant/prompt-modules/skill.demo-skill/value').send({ fromSeq: baselineSeq }).expect(200);
    const md = readFileSync(join(tmpDataDir, 'skills', 'demo-skill', 'SKILL.md'), 'utf8');
    expect(md).toContain('旧正文');
    expect(md.startsWith('---\nname: "demo-skill"\ndescription: "演示技能"\n---\n')).toBe(true); // frontmatter 从 DB 重拼
  });

  it('非管理员 → 403', async () => {
    const app = await mount('member');
    await request(app).get('/api/assistant/prompt-modules').expect(403);
  });
});
