/** 固化管线路由：scan 202/409 防重入/批次与提案查询/approve/reject/权限门。 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import type { Express } from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';
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
  tmpDataDir = mkdtempSync(join(tmpdir(), 'itest-sr-'));
  process.env.PI_DATA_DIR = tmpDataDir;
  ({ managerUserOf, memberUserOf } = await import('./helpers/auth.js'));
  const { spaceRoute } = await import('../src/pi/space/router.js');
  const express = (await import('express')).default;
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  mount = async (role) => {
    // manager 用 seedOrg 落库的真实 userId：scan/approve 写 created_by/reviewed_by 有 FK 约束；
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
  await pool.query(`TRUNCATE assistant_solidify_proposals, assistant_solidify_batches, assistant_prompt_module_versions, assistant_memories, assistant_trajectories, assistant_skills, settings`);
});

async function seedPendingProposal(): Promise<{ id: string; batchId: string; memoryId: string }> {
  const { productLineId: lineId } = await seedProject(pool);
  const memoryId = randomUUID();
  await pool.query(`INSERT INTO assistant_memories (id, scope, product_line_id, title, hook, provenance) VALUES ($1, 'product_line', $2, 'm', 'h', 'ai_inferred')`, [memoryId, lineId]);
  const batchId = (await pool.query(`INSERT INTO assistant_solidify_batches (status) VALUES ('done') RETURNING id`)).rows[0]!.id as string;
  const id = (await pool.query(
    `INSERT INTO assistant_solidify_proposals (batch_id, kind, target, title, body, rationale, sources, distill_model)
     VALUES ($1, 'prompt_amendment', 'space.style.zh', '提案', 'b', 'r', $2::jsonb, 'm') RETURNING id`,
    [batchId, JSON.stringify([{ type: 'memory', id: memoryId, title: 'src', retireRecommended: true }])],
  )).rows[0]!.id as string;
  return { id, batchId, memoryId };
}

describe('solidify 路由', () => {
  it('POST /scan：202 + 批次 id；running 时再发 → 409', async () => {
    const app = await mount('manager');
    const res = await request(app).post('/api/assistant/solidify/scan').expect(202);
    expect(res.body.id).toBeTruthy();
    // 未配置 LLM 时 fire-and-forget 蒸馏毫秒级把批次置 failed（running 窗口一闪而过）。
    // 等它收场后置回 running，确定性验证 409 防重入（直插 running 的用例见下一条）。
    for (let i = 0; i < 50; i++) {
      const b = await pool.query(`SELECT status FROM assistant_solidify_batches WHERE id=$1`, [res.body.id]);
      if (b.rows[0].status !== 'running') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await pool.query(`UPDATE assistant_solidify_batches SET status='running' WHERE id=$1`, [res.body.id]);
    await request(app).post('/api/assistant/solidify/scan').expect(409);
  });

  it('POST /scan：running 批次存在 → 409（稳定复现）', async () => {
    const app = await mount('manager');
    await pool.query(`INSERT INTO assistant_solidify_batches (status) VALUES ('running')`);
    await request(app).post('/api/assistant/solidify/scan').expect(409);
  });

  it('GET /batches：批次历史（含 error）+ 分页 + status 过滤', async () => {
    const app = await mount('manager');
    await pool.query(`INSERT INTO assistant_solidify_batches (status, input_summary) VALUES ('done', '{}')`);
    const res = await request(app).get('/api/assistant/solidify/batches').expect(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    expect(res.body.items[0].status).toBeTruthy();
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(20);

    // 分页：3 条 running → limit=2 时 page1 两页、page2 一条，跨页不重不漏
    for (let i = 0; i < 3; i++) {
      await pool.query(`INSERT INTO assistant_solidify_batches (status, input_summary) VALUES ('running', '{}')`);
    }
    const p1 = await request(app).get('/api/assistant/solidify/batches?page=1&limit=2').expect(200);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.total).toBe(4);
    const p2 = await request(app).get('/api/assistant/solidify/batches?page=2&limit=2').expect(200);
    expect(p2.body.items).toHaveLength(2);
    const p3 = await request(app).get('/api/assistant/solidify/batches?page=3&limit=2').expect(200);
    expect(p3.body.items).toHaveLength(0);

    // status 过滤（前端「扫描中」检测走这个）
    const running = await request(app).get('/api/assistant/solidify/batches?status=running&limit=1').expect(200);
    expect(running.body.total).toBe(3);
    expect(running.body.items).toHaveLength(1);
    expect(running.body.items[0].status).toBe('running');
  });

  it('GET /proposals：batchId/status 过滤；GET /proposals/:id 详情含 sources', async () => {
    const app = await mount('manager');
    const { id, batchId } = await seedPendingProposal();
    const all = await request(app).get('/api/assistant/solidify/proposals').expect(200);
    expect(all.body.items).toHaveLength(1);
    expect(all.body.total).toBe(1);
    const byBatch = await request(app).get(`/api/assistant/solidify/proposals?batchId=${batchId}`).expect(200);
    expect(byBatch.body.items).toHaveLength(1);
    const byStatus = await request(app).get('/api/assistant/solidify/proposals?status=rejected').expect(200);
    expect(byStatus.body.items).toHaveLength(0);
    expect(byStatus.body.total).toBe(0);
    const detail = await request(app).get(`/api/assistant/solidify/proposals/${id}`).expect(200);
    expect(detail.body.sources[0].type).toBe('memory');
    await request(app).get(`/api/assistant/solidify/proposals/${randomUUID()}`).expect(404);
  });

  it('GET /proposals：分页 + 待审优先排序（pending 排在已审之前）', async () => {
    const app = await mount('manager');
    // 造 3 条：1 条已驳回 + 2 条待审（待审更早创建，仍须排在前面）
    const batchId = (await pool.query(`INSERT INTO assistant_solidify_batches (status) VALUES ('done') RETURNING id`)).rows[0]!.id as string;
    const insert = async (title: string, status: string) => {
      await pool.query(
        `INSERT INTO assistant_solidify_proposals (batch_id, kind, target, title, body, rationale, sources, distill_model, status, created_at)
         VALUES ($1, 'prompt_amendment', 'space.style.zh', $2, 'b', 'r', '[]'::jsonb, 'm', $3, now())`,
        [batchId, title, status],
      );
    };
    await insert('已驳回', 'rejected');
    await insert('待审-1', 'pending');
    await insert('待审-2', 'pending');

    const p1 = await request(app).get('/api/assistant/solidify/proposals?page=1&limit=2').expect(200);
    expect(p1.body.total).toBe(3);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.items[0].status).toBe('pending');
    expect(p1.body.items[1].status).toBe('pending');
    const p2 = await request(app).get('/api/assistant/solidify/proposals?page=2&limit=2').expect(200);
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.items[0].status).toBe('rejected');
  });

  it('POST /proposals/:id/approve：默认不退役；retireIds 退役来源', async () => {
    const app = await mount('manager');
    const { id, memoryId } = await seedPendingProposal();
    await request(app).post(`/api/assistant/solidify/proposals/${id}/approve`).send({ retireIds: [] }).expect(200);
    let m = (await pool.query(`SELECT status FROM assistant_memories WHERE id=$1`, [memoryId])).rows[0]!;
    expect(m.status).toBe('active');

    // 再造一条 pending 提案验证带退役的批准
    const p2 = await seedPendingProposal();
    await request(app).post(`/api/assistant/solidify/proposals/${p2.id}/approve`).send({ retireIds: [p2.memoryId] }).expect(200);
    m = (await pool.query(`SELECT status FROM assistant_memories WHERE id=$1`, [p2.memoryId])).rows[0]!;
    expect(m.status).toBe('retired_solidified');
    // 重复批 → 409
    await request(app).post(`/api/assistant/solidify/proposals/${p2.id}/approve`).send({ retireIds: [] }).expect(409);
  });

  it('POST /proposals/:id/reject：200 + 状态 rejected', async () => {
    const app = await mount('manager');
    const { id } = await seedPendingProposal();
    await request(app).post(`/api/assistant/solidify/proposals/${id}/reject`).send({}).expect(200);
    const p = (await pool.query(`SELECT status FROM assistant_solidify_proposals WHERE id=$1`, [id])).rows[0]!;
    expect(p.status).toBe('rejected');
  });

  it('非管理员 → 403', async () => {
    const app = await mount('member');
    await request(app).post('/api/assistant/solidify/scan').expect(403);
    await request(app).get('/api/assistant/solidify/batches').expect(403);
  });
});
