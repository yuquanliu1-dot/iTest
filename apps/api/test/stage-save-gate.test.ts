import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

// P1-3 persistence gate: /stage/save intercepts dead steps (no compiled and no instruction) with 422 + advisory warnings for pure NL drafts.
// Route-level test (supertest + the real stageRoute), mounted the same way as space-guides.test.ts.
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 1).toString('base64');
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  const { default: exp } = await import('express');
  const { spaceRoute } = await import('../src/pi/space/router.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const { userId, username, orgId, orgPath } = await (await import('./helpers/db.js')).seedOrg(pool);
  const { managerUserOf } = await import('./helpers/auth.js');
  app = exp();
  app.use(exp.json());
  app.use((req, _res, next) => { req.user = managerUserOf(userId, username, orgId, orgPath); next(); });
  app.use('/api/assistant', spaceRoute);
  app.use(errorHandler);
  // Dynamic import: the stageRoute chain statically imports db/client (DATABASE_URL only points at the container inside beforeAll)
  await import('../src/db/client.js');
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
});

beforeEach(async () => {
  // Only clear this test domain's tables; org/project rows stay for seedOrg/seedProject reuse (the org cache stays valid)
  await pool.query(`TRUNCATE ai_threads, ai_stage_cases, ai_stage_case_ops, test_steps, test_cases RESTART IDENTITY CASCADE`);
});

/** Create a version thread + one staged case draft, returning threadId/localId/groupId. */
async function seedDraft(steps: Array<Record<string, unknown>>, title = '草稿用例'): Promise<{ threadId: string; localId: string; groupId: string }> {
  const { versionId, groupId } = await seedProject(pool);
  const threadId = randomUUID();
  await pool.query(`INSERT INTO ai_threads(id, kind, version_id, pi_thread_id) VALUES ($1,'version',$2,'')`, [threadId, versionId]);
  const localId = randomUUID();
  await pool.query(
    `INSERT INTO ai_stage_cases(thread_id, local_id, version_id, title, url, steps) VALUES ($1, $2, $3, $4, 'http://env.example/page', $5::jsonb)`,
    [threadId, localId, versionId, title, JSON.stringify(steps)],
  );
  return { threadId, localId, groupId };
}

/** Create a version thread + one persisted case (with N steps), returning threadId/caseId/stepIds/versionId. */
async function seedDbCase(stepCount = 2): Promise<{ threadId: string; caseId: string; stepIds: string[]; versionId: string }> {
  const { versionId, groupId } = await seedProject(pool);
  const threadId = randomUUID();
  await pool.query(`INSERT INTO ai_threads(id, kind, version_id, pi_thread_id) VALUES ($1,'version',$2,'')`, [threadId, versionId]);
  const caseId = randomUUID();
  await pool.query(
    `INSERT INTO test_cases(id, group_id, version_id, title, url) VALUES ($1, $2, $3, '落库用例', 'http://env.example/page')`,
    [caseId, groupId, versionId],
  );
  const stepIds: string[] = [];
  for (let i = 1; i <= stepCount; i++) {
    const r = await pool.query(
      `INSERT INTO test_steps(case_id, "order", source, instruction, compiled) VALUES ($1, $2, 'ai', $3, NULL) RETURNING id`,
      [caseId, i, `第 ${i} 步`],
    );
    stepIds.push(r.rows[0]!.id as string);
  }
  return { threadId, caseId, stepIds, versionId };
}

/** Create one staged op row (staged_at controllable, to pin the application order within a batch). */
async function seedCaseOp(
  row: { threadId: string; versionId: string; caseId: string; localId: string; op: string; payload: unknown; summary?: string; at?: number },
): Promise<void> {
  await pool.query(
    `INSERT INTO ai_stage_case_ops(thread_id, local_id, version_id, case_id, op, payload, summary, staged_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [
      row.threadId, row.localId, row.versionId, row.caseId, row.op,
      JSON.stringify(row.payload), row.summary ?? '暂存修改',
      new Date(row.at ?? Date.now()).toISOString(),
    ],
  );
}

describe('POST /threads/:id/stage/save — 死步骤拦截与 NL 草稿告警', () => {
  it('死步骤（无 compiled 且无指令）→ 422 dead_steps 点名步骤序号，不落库且 stage 行保留', async () => {
    const { threadId, localId, groupId } = await seedDraft([
      { action: '点击登录按钮', compiled: null, assertion: null },
      { action: '', compiled: null, assertion: null }, // dead step: neither DSL nor an instruction
    ], '死步用例');
    const r = await request(app).post(`/api/assistant/threads/${threadId}/stage/save`)
      .send({ cases: [{ localId, groupId }] });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('dead_steps');
    expect(r.body.message).toContain('死步用例');
    expect(r.body.message).toContain('第 2 步');
    // Interception semantics: the case isn't created and the staged row isn't deleted (the user can have the assistant finish it and retry)
    const caseRows = await pool.query(`SELECT count(*)::int n FROM test_cases`);
    expect(caseRows.rows[0]!.n).toBe(0);
    const stageRows = await pool.query(`SELECT count(*)::int n FROM ai_stage_cases WHERE local_id = $1`, [localId]);
    expect(stageRows.rows[0]!.n).toBe(1);
  });

  it('纯 NL 草稿（有指令 + 字符串断言）→ 保存成功且带 advisory warnings', async () => {
    const { threadId, localId, groupId } = await seedDraft([
      { action: '输入用户名并点击登录', compiled: null, assertion: '页面提示登录成功' },
    ], 'NL草稿用例');
    const r = await request(app).post(`/api/assistant/threads/${threadId}/stage/save`)
      .send({ cases: [{ localId, groupId }] });
    expect(r.status).toBe(200);
    expect(r.body.savedCases).toBe(1);
    expect(Array.isArray(r.body.warnings)).toBe(true);
    expect(String(r.body.warnings[0])).toContain('自然语言草稿');
    expect(String(r.body.warnings[0])).toContain('NL草稿用例');
    // Instructions persist in full; string assertions migrate through createCaseWithSteps into canonical form
    // ({kind:'assertText', target:'page', locator:[]} — exactly the whole-page fuzzy assertion mechanical replay skips, which motivates the advisory warning)
    const row = (await pool.query(
      `SELECT c.title, s.instruction, s.assertion FROM test_cases c JOIN test_steps s ON s.case_id = c.id`,
    )).rows[0]!;
    expect(row.title).toBe('NL草稿用例');
    expect(row.instruction).toBe('输入用户名并点击登录');
    expect(row.assertion).toMatchObject({ kind: 'assertText', equals: '页面提示登录成功', locator: [] });
    const stageRows = await pool.query(`SELECT count(*)::int n FROM ai_stage_cases WHERE local_id = $1`, [localId]);
    expect(stageRows.rows[0]!.n).toBe(0);
  });

  it('已编译步骤（有 compiled）→ 保存成功且无 warnings', async () => {
    const { threadId, localId, groupId } = await seedDraft([
      {
        action: '点击删除',
        compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#del' }] }],
        assertion: null,
      },
    ]);
    const r = await request(app).post(`/api/assistant/threads/${threadId}/stage/save`)
      .send({ cases: [{ localId, groupId }] });
    expect(r.status).toBe(200);
    expect(r.body.savedCases).toBe(1);
    expect(r.body.warnings).toBeUndefined();
  });
});

// Regression motive: prod228 2026-11-11 — solidification staged an overlaid-state step (stepId shaped like 'staged:1', not yet in the DB)
// as update_step; at persistence the non-uuid stepId → bare ZodError → the frontend only saw "parameter validation failed, please check input";
// and the failure didn't roll back, so user retries inserted the same step 3 times.
// Fix: (1) solidification no longer produces that op (root cause, see pi-solidify-case.test.ts); (2) full pre-validation before persistence, writing nothing.
describe('POST /threads/:id/stage/save — caseOps 落库前预检', () => {
  it('非法 stepId（非 uuid，如叠加态占位）→ 400 可读报错，一条都不写，暂存行保留', async () => {
    const { threadId, caseId, stepIds, versionId } = await seedDbCase(2);
    await seedCaseOp({
      threadId, versionId, caseId, localId: 'solidify-staged:1', op: 'update_step',
      payload: { action: 'update_step', caseId, stepId: 'staged:1', compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#del' }] }] },
      summary: '第 2 步 固化',
    });
    const r = await request(app).post(`/api/assistant/threads/${threadId}/stage/save`)
      .send({ caseOps: [{ localId: 'solidify-staged:1' }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('staged_op_invalid');
    expect(String(r.body.message)).toContain('参数不合法');
    expect(String(r.body.message)).toContain('stepId');
    expect(String(r.body.message)).toContain('第 2 步 固化'); // names which op it is
    // Nothing written: the step's compiled stays NULL
    const rows = await pool.query(`SELECT id, compiled FROM test_steps WHERE case_id = $1 ORDER BY "order"`, [caseId]);
    expect(rows.rows.every((r) => r.compiled === null)).toBe(true);
    // Staged row kept (the user can cancel this op and retry)
    const stageRows = await pool.query(`SELECT count(*)::int n FROM ai_stage_case_ops WHERE local_id = 'solidify-staged:1'`);
    expect(stageRows.rows[0]!.n).toBe(1);
    expect(stepIds).toHaveLength(2);
  });

  it('批次中段出现非法 op → 排在它前面的合法 op 也不落库（全批原子拦下）', async () => {
    const { threadId, caseId, stepIds, versionId } = await seedDbCase(2);
    // staged_at increasing → the legal op first, the illegal op after (simulating a mid-batch failure where "the earlier row was written, the later one blew up")
    await seedCaseOp({
      threadId, versionId, caseId, localId: 'ok-1', op: 'update_step',
      payload: { action: 'update_step', caseId, stepId: stepIds[0], compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#del' }] }] },
      summary: '第 1 步 固化', at: Date.now() - 60_000,
    });
    await seedCaseOp({
      threadId, versionId, caseId, localId: 'bad-2', op: 'update_step',
      payload: { action: 'update_step', caseId, stepId: 'staged:9', compiled: null },
      summary: '第 2 步 固化',
    });
    const r = await request(app).post(`/api/assistant/threads/${threadId}/stage/save`)
      .send({ caseOps: [{ localId: 'ok-1' }, { localId: 'bad-2' }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('staged_op_invalid');
    // Key invariant: the legal op also wrote nothing (this is exactly what caused prod228's 3 duplicate inserts)
    const rows = await pool.query(`SELECT compiled FROM test_steps WHERE case_id = $1 ORDER BY "order"`, [caseId]);
    expect(rows.rows.every((r) => r.compiled === null)).toBe(true);
  });

  it('stepId 是合法 uuid 但步骤不存在 → 400 点名该步骤 id，一条都不写', async () => {
    const { threadId, caseId, versionId } = await seedDbCase(1);
    const ghostId = randomUUID();
    await seedCaseOp({
      threadId, versionId, caseId, localId: 'ghost-1', op: 'update_step',
      payload: { action: 'update_step', caseId, stepId: ghostId, compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#del' }] }] },
      summary: '第 1 步 固化',
    });
    const r = await request(app).post(`/api/assistant/threads/${threadId}/stage/save`)
      .send({ caseOps: [{ localId: 'ghost-1' }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('staged_op_invalid');
    expect(String(r.body.message)).toContain('引用的步骤不存在');
    expect(String(r.body.message)).toContain(ghostId);
    const rows = await pool.query(`SELECT compiled FROM test_steps WHERE case_id = $1`, [caseId]);
    expect(rows.rows[0]!.compiled).toBeNull();
  });

  it('move_step 未覆盖全部步骤 → 400 点名，不重排（避免同批次前面的 op 已写）', async () => {
    const { threadId, caseId, stepIds, versionId } = await seedDbCase(2);
    await seedCaseOp({
      threadId, versionId, caseId, localId: 'mv-1', op: 'move_step',
      payload: { action: 'move_step', caseId, stepIds: [stepIds[0]!] }, // one missing
      summary: '步骤重排',
    });
    const r = await request(app).post(`/api/assistant/threads/${threadId}/stage/save`)
      .send({ caseOps: [{ localId: 'mv-1' }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('staged_op_invalid');
    expect(String(r.body.message)).toContain('move_step');
    expect(String(r.body.message)).toContain('必须恰好覆盖');
    const rows = await pool.query(`SELECT "order" FROM test_steps WHERE case_id = $1 ORDER BY "order"`, [caseId]);
    expect(rows.rows.map((r) => r.order)).toEqual([1, 2]);
  });

  it('合法 update_step（真实 stepId）→ 落库成功，compiled 写入，暂存行删除', async () => {
    const { threadId, caseId, stepIds, versionId } = await seedDbCase(1);
    await seedCaseOp({
      threadId, versionId, caseId, localId: 'ok-1', op: 'update_step',
      payload: { action: 'update_step', caseId, stepId: stepIds[0], compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#del' }] }] },
      summary: '第 1 步 固化',
    });
    const r = await request(app).post(`/api/assistant/threads/${threadId}/stage/save`)
      .send({ caseOps: [{ localId: 'ok-1' }] });
    expect(r.status).toBe(200);
    expect(r.body.savedCaseOps).toBe(1);
    const row = await pool.query(`SELECT compiled FROM test_steps WHERE id = $1`, [stepIds[0]]);
    expect(row.rows[0]!.compiled).toEqual([{ kind: 'click', locator: [{ strategy: 'css', value: '#del' }] }]);
    const stageRows = await pool.query(`SELECT count(*)::int n FROM ai_stage_case_ops WHERE local_id = 'ok-1'`);
    expect(stageRows.rows[0]!.n).toBe(0);
  });
});
