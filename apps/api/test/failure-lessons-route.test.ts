/** Failure lesson routes: list (status filter) / retire (active guard 404) / permission gate. */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import type { Express } from 'express';
import request from 'supertest';
import { SCHEMA_SQL, seedOrg } from './helpers/db.js';
// auth helpers cannot be statically imported: auth.service → db/client snapshots
// DATABASE_URL at module-load time, which would point the app db at the pre-beforeAll-env database (same gotcha as prompt-modules-route).
let managerUserOf: typeof import('./helpers/auth.js').managerUserOf;
let memberUserOf: typeof import('./helpers/auth.js').memberUserOf;

let pool: Pool;
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
  ({ managerUserOf, memberUserOf } = await import('./helpers/auth.js'));
  const { spaceRoute } = await import('../src/pi/space/router.js');
  const express = (await import('express')).default;
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  mount = async (role) => {
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
});

beforeEach(async () => {
  await pool.query(`TRUNCATE assistant_failure_lessons`);
});

async function seedLesson(status: string, title: string): Promise<string> {
  return (await pool.query(
    `INSERT INTO assistant_failure_lessons (status, attribution, title, lesson, signals, distill_model) VALUES ($1, 'prompt', $2, 'l', '[]', 'm') RETURNING id`,
    [status, title])).rows[0]!.id as string;
}

describe('failure-lessons 路由', () => {
  it('member GET → 403', async () => {
    const app = await mount('member');
    await request(app).get('/api/assistant/failure-lessons').expect(403);
  });

  it('manager GET 默认 active：seed 三种状态只回 active', async () => {
    const app = await mount('manager');
    await seedLesson('active', '活跃教训');
    await seedLesson('resolved', '已解决教训');
    await seedLesson('retired', '已退役教训');
    const r = await request(app).get('/api/assistant/failure-lessons').expect(200);
    expect(r.body.map((l: { title: string }) => l.title)).toEqual(['活跃教训']);
  });

  it('manager GET ?status=resolved → 回 resolved', async () => {
    const app = await mount('manager');
    await seedLesson('active', '活跃');
    const rid = await seedLesson('resolved', '已解决');
    const r = await request(app).get('/api/assistant/failure-lessons?status=resolved').expect(200);
    expect(r.body.map((l: { id: string }) => l.id)).toEqual([rid]);
  });

  it('manager GET ?status=bogus → 400', async () => {
    const app = await mount('manager');
    await request(app).get('/api/assistant/failure-lessons?status=bogus').expect(400);
  });

  it('manager POST /:id/retire active 行 → 200 且 DB status=retired', async () => {
    const app = await mount('manager');
    const id = await seedLesson('active', '待退役');
    await request(app).post(`/api/assistant/failure-lessons/${id}/retire`).expect(200, { ok: true });
    const row = (await pool.query(`SELECT status FROM assistant_failure_lessons WHERE id=$1`, [id])).rows[0]!;
    expect(row.status).toBe('retired');
  });

  it('manager POST /:id/retire 已 retired 行 → 404', async () => {
    const app = await mount('manager');
    const id = await seedLesson('retired', '已退役');
    await request(app).post(`/api/assistant/failure-lessons/${id}/retire`).expect(404);
  });
});
