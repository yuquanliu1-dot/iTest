import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

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
  // 只清 guides/mcp 两表（不动 org/project 行），org 缓存仍有效，无需 resetSeedOrgCache
  await pool.query(`TRUNCATE assistant_guides, assistant_mcp_servers`);
});

describe('S1 guides：seed 幂等 + loadActiveGuides 语义 + CRUD/鉴权', () => {
  it('seedAssistantGuides 跑两遍仍是 3 行（REQ_DESIGN_METHOD·any + FLOW·zh/en）', async () => {
    const { seedAssistantGuides } = await import('../src/db/seed.js');
    await seedAssistantGuides(pool);
    const first = (await pool.query(`SELECT count(*)::int n FROM assistant_guides`)).rows[0]!.n as number;
    await seedAssistantGuides(pool); // 模拟容器二次启动
    const second = (await pool.query(`SELECT count(*)::int n FROM assistant_guides`)).rows[0]!.n as number;
    expect(first).toBe(3);
    expect(second).toBe(3); // ON CONFLICT (id) DO NOTHING 幂等
    const rows = (await pool.query(`SELECT lang::text lang, kind::text kind FROM assistant_guides ORDER BY id`)).rows;
    expect(rows.map((r) => `${r.kind}:${r.lang}`).sort()).toEqual(['flow:any', 'flow:en', 'flow:zh']);
  });

  it('loadActiveGuides：scope version>project>global + sort + lang/enabled 过滤', async () => {
    const { projectId, versionId } = await seedProject(pool);
    await pool.query(`INSERT INTO assistant_guides (id, scope, kind, body, lang, sort, project_id, version_id, enabled) VALUES
      ($1,'version','flow','V-BODY','zh',0,NULL,$2,true),
      ($3,'project','flow','P-BODY','zh',0,$4,NULL,true),
      ($5,'global','flow','G-BODY','zh',1,NULL,NULL,true),
      ($6,'global','reference','REF-BODY','zh',0,NULL,NULL,true),
      ($7,'global','flow','G-OFF','zh',0,NULL,NULL,false),
      ($8,'global','flow','G-EN','en',0,NULL,NULL,true)`,
      [randomUUID(), versionId, randomUUID(), projectId, randomUUID(), randomUUID(), randomUUID(), randomUUID()]);
    const { loadActiveGuides } = await import('../src/pi/space/guides.js');
    const rows = await loadActiveGuides({ projectId, versionId, lang: 'zh-CN' });
    expect(rows.map((r) => r.body)).toEqual(['V-BODY', 'P-BODY', 'REF-BODY', 'G-BODY']);
    expect(rows.every((r) => r.enabled)).toBe(true); // G-OFF 不注入
    expect(rows.every((r) => r.lang === 'zh' || r.lang === 'any')).toBe(true); // G-EN 不注入
  });

  it('CRUD：manager 建/查/改/删全通；member 一律 403', async () => {
    const created = await request(managerApp).post('/api/assistant/guides')
      .send({ scope: 'global', kind: 'flow', body: 'HELLO', lang: 'zh' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const listed = await request(managerApp).get('/api/assistant/guides?lang=zh');
    expect(listed.status).toBe(200);
    expect(listed.body.map((g: { id: string }) => g.id)).toContain(id);
    const patched = await request(managerApp).patch(`/api/assistant/guides/${id}`).send({ enabled: false, body: 'HELLO2' });
    expect(patched.status).toBe(200);
    expect(patched.body.enabled).toBe(false);
    expect((await request(managerApp).delete(`/api/assistant/guides/${id}`)).status).toBe(204);
    expect((await request(managerApp).get('/api/assistant/guides')).body.length).toBe(0);
    // member：requireManager → 403（managerOrgPaths 为空，isEffectiveManager=false）
    expect((await request(memberApp).post('/api/assistant/guides')
      .send({ scope: 'global', kind: 'flow', body: 'X', lang: 'zh' })).status).toBe(403);
    expect((await request(memberApp).get('/api/assistant/guides')).status).toBe(403);
    expect((await request(memberApp).patch(`/api/assistant/guides/${id}`).send({ enabled: true })).status).toBe(403);
    expect((await request(memberApp).delete(`/api/assistant/guides/${id}`)).status).toBe(403);
  });

  it('POST 校验：scope 缺 projectId → 400；非法 kind/lang → 400', async () => {
    expect((await request(managerApp).post('/api/assistant/guides')
      .send({ scope: 'project', kind: 'flow', body: 'X' })).status).toBe(400);
    expect((await request(managerApp).post('/api/assistant/guides')
      .send({ scope: 'global', kind: 'nope', body: 'X' })).status).toBe(400);
    expect((await request(managerApp).post('/api/assistant/guides')
      .send({ scope: 'global', kind: 'flow', body: '' })).status).toBe(400);
  });
});