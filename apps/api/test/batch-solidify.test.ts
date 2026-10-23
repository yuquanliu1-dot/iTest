import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

// 批量固化 job 单测：solidify/verify 两个工具模块整体打桩（真实编排已由 pi-*-case 套件覆盖），
// 聚焦 batchSolidify 自身契约——资格校验 / materialize 事务 / job 状态机与「保留 DSL」失败语义。
vi.mock('../src/pi/space/tools/solidifyCase.js', () => ({
  buildSolidifyCaseTool: vi.fn(),
}));
vi.mock('../src/pi/space/tools/verifyCase.js', () => ({
  buildVerifyCaseTool: vi.fn(),
}));

let container: StartedPostgreSqlContainer;
let pool: Pool;
let projectId: string;
let groupId: string;
let versionId: string;
let app: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  // supertest 应用（路由层测试用）：注入种子组织管理员身份，挂 cases 路由
  const { default: express } = await import('express');
  const { casesRoute } = await import('../src/routes/cases.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  const { managerUserOf } = await import('./helpers/auth.js');
  app = express();
  app.use(express.json());
  app.use('/api/cases', (req, _res, next) => {
    req.user = managerUserOf(userId, username, orgId, orgPath);
    next();
  });
  app.use('/api/cases', casesRoute);
  app.use('/api/cases', errorHandler);
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await pool.query(`TRUNCATE test_steps, test_cases, test_environments, environment_objects,
    requirements, "groups", projects, project_versions, ai_threads, ai_stage_case_ops, ai_stage_cases,
    solidify_batch_cases, solidify_batches
    RESTART IDENTITY CASCADE`);
  const seed = await seedProject(pool);
  projectId = seed.projectId;
  groupId = seed.groupId;
  versionId = seed.versionId;
});

/** 全未固化 web 用例（compiled 全 NULL）。 */
async function seedCase(opts: { versionId?: string | null; platform?: string; steps?: Array<{ instruction?: string | null; compiled?: unknown[] | null; sensitive?: boolean }> } = {}): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO test_cases(id, group_id, version_id, title, platform) VALUES ($1, $2, $3, '批量固化用例', $4)`,
    [id, groupId, opts.versionId === undefined ? versionId : opts.versionId, opts.platform ?? 'web'],
  );
  for (let i = 0; i < (opts.steps ?? [{ instruction: '点击删除按钮' }]).length; i++) {
    const s = (opts.steps ?? [{ instruction: '点击删除按钮' }])[i]!;
    await pool.query(
      `INSERT INTO test_steps(case_id, "order", source, instruction, compiled, sensitive) VALUES ($1, $2, 'ai', $3, $4::jsonb, $5)`,
      [id, i + 1, s.instruction ?? null, s.compiled ? JSON.stringify(s.compiled) : null, s.sensitive ?? false],
    );
  }
  return id;
}

async function stepRows(caseId: string): Promise<Array<{ id: string; compiled: unknown }>> {
  const r = await pool.query(`SELECT id, compiled FROM test_steps WHERE case_id = $1 ORDER BY "order"`, [caseId]);
  return r.rows as Array<{ id: string; compiled: unknown }>;
}

/** 建批次 + queued 行，返回 batchId。 */
async function seedBatch(caseIds: string[]): Promise<string> {
  const batchId = randomUUID();
  await pool.query(`INSERT INTO solidify_batches(id, project_id) VALUES ($1, $2)`, [batchId, projectId]);
  for (const caseId of caseIds) {
    await pool.query(
      `INSERT INTO solidify_batch_cases(batch_id, case_id, status) VALUES ($1, $2, 'queued')`,
      [batchId, caseId],
    );
  }
  return batchId;
}

async function batchRow(batchId: string, caseId: string): Promise<{ status: string; error: string | null; solidify_result: unknown; verify_result: unknown; started_at: Date | null; finished_at: Date | null }> {
  const r = await pool.query(
    `SELECT status, error, solidify_result, verify_result, started_at, finished_at FROM solidify_batch_cases WHERE batch_id = $1 AND case_id = $2`,
    [batchId, caseId],
  );
  return r.rows[0] as { status: string; error: string | null; solidify_result: unknown; verify_result: unknown; started_at: Date | null; finished_at: Date | null };
}

/** 让 mock solidify 工具像真工具那样往 batch 草稿区写 solidify-% 暂存（materialize 的输入）。 */
function stageSolidifyOps(caseId: string, stepIds: string[], compiled: unknown[]): (input: unknown) => Promise<{ ok: true; data: string }> {
  return async (input: unknown) => {
    const { caseId: cid } = input as { caseId: string };
    const threadId = `batch-${(await pool.query(`SELECT batch_id FROM solidify_batch_cases WHERE case_id = $1 LIMIT 1`, [cid])).rows[0]!.batch_id}`;
    for (const stepId of stepIds) {
      await pool.query(
        `INSERT INTO ai_stage_case_ops(thread_id, local_id, version_id, case_id, op, payload, summary)
         VALUES ($1, $2, $3, $4, 'update_step', $5::jsonb, '批量固化')`,
        [threadId, `solidify-${stepId}`, versionId, cid, JSON.stringify({ action: 'update_step', caseId: cid, stepId, compiled })],
      );
    }
    return { ok: true, data: JSON.stringify({ result: 'solidified', steps: stepIds.map((_, i) => ({ order: i + 1, status: 'solidified' })) }) };
  };
}

async function mockSolidify(impl: (input: unknown) => Promise<{ ok: boolean; data?: string; error?: string }>): Promise<void> {
  const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
  vi.mocked(buildSolidifyCaseTool).mockReturnValue({ execute: impl } as never);
}

describe('checkBatchEligibility', () => {
  it('全未固化 web 用例 → ok:true（带 projectId 供路由建批次行）', async () => {
    const caseId = await seedCase();
    const { checkBatchEligibility } = await import('../src/execute/batchSolidify.js');
    await expect(checkBatchEligibility(caseId)).resolves.toEqual({ ok: true, projectId });
  });

  it('mobile 用例 → 拒绝', async () => {
    const caseId = await seedCase({ platform: 'mobile' });
    const { checkBatchEligibility } = await import('../src/execute/batchSolidify.js');
    const r = await checkBatchEligibility(caseId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('web');
  });

  it('未绑定版本 → 拒绝', async () => {
    const caseId = await seedCase({ versionId: null });
    const { checkBatchEligibility } = await import('../src/execute/batchSolidify.js');
    const r = await checkBatchEligibility(caseId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('版本');
  });

  it('无步骤 → 拒绝', async () => {
    const caseId = await seedCase({ steps: [] });
    const { checkBatchEligibility } = await import('../src/execute/batchSolidify.js');
    const r = await checkBatchEligibility(caseId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('没有步骤');
  });

  it('已有固化步骤 → 拒绝（需求口径=全部未固化）', async () => {
    const caseId = await seedCase({
      steps: [{ instruction: '点击' }, { compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#a' }] }] }],
    });
    const { checkBatchEligibility } = await import('../src/execute/batchSolidify.js');
    const r = await checkBatchEligibility(caseId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('已有固化步骤');
  });

  it('纯敏感步（无视觉步）→ 拒绝', async () => {
    const caseId = await seedCase({ steps: [{ instruction: '输入口令', sensitive: true }] });
    const { checkBatchEligibility } = await import('../src/execute/batchSolidify.js');
    const r = await checkBatchEligibility(caseId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('视觉模式');
  });

  it('已有进行中的固化任务 → 拒绝（防重复触发）', async () => {
    const caseId = await seedCase();
    await seedBatch([caseId]);
    await pool.query(`UPDATE solidify_batch_cases SET status = 'verifying'`);
    const { checkBatchEligibility } = await import('../src/execute/batchSolidify.js');
    const r = await checkBatchEligibility(caseId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('进行中');
  });

  it('用例不存在 → 拒绝', async () => {
    const { checkBatchEligibility } = await import('../src/execute/batchSolidify.js');
    await expect(checkBatchEligibility(randomUUID())).resolves.toEqual({ ok: false, reason: '用例不存在' });
  });
});

describe('materializeStagedOps', () => {
  it('solidify-% 暂存 → test_steps.compiled 逐条落库 + 暂存删除（单事务）', async () => {
    const caseId = await seedCase({ steps: [{ instruction: '点击删除按钮' }, { instruction: '填写名称' }] });
    const steps = await stepRows(caseId);
    await pool.query(
      `INSERT INTO ai_stage_case_ops(thread_id, local_id, version_id, case_id, op, payload, summary)
       VALUES ('batch-b1', $1, $2, $3, 'update_step', $4::jsonb, 'x'), ('batch-b1', $5, $2, $3, 'update_step', $6::jsonb, 'x')`,
      [
        `solidify-${steps[0]!.id}`, versionId, caseId,
        JSON.stringify({ action: 'update_step', caseId, stepId: steps[0]!.id, compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#del' }] }] }),
        `solidify-${steps[1]!.id}`,
        JSON.stringify({ action: 'update_step', caseId, stepId: steps[1]!.id, compiled: [{ kind: 'fill', locator: [{ strategy: 'css', value: '#n' }], value: 'x' }] }),
      ],
    );
    const { materializeStagedOps } = await import('../src/execute/batchSolidify.js');
    await expect(materializeStagedOps('batch-b1', caseId)).resolves.toBe(2);
    const after = await stepRows(caseId);
    expect(after[0]!.compiled).toEqual([{ kind: 'click', locator: [{ strategy: 'css', value: '#del' }] }]);
    expect(after[1]!.compiled).toEqual([{ kind: 'fill', locator: [{ strategy: 'css', value: '#n' }], value: 'x' }]);
    const ops = await pool.query(`SELECT * FROM ai_stage_case_ops WHERE thread_id = 'batch-b1'`);
    expect(ops.rows).toHaveLength(0); // 暂存已清
  });

  it('非 solidify-% 暂存不受影响；草稿区无暂存 → 抛错', async () => {
    const caseId = await seedCase();
    const steps = await stepRows(caseId);
    await pool.query(
      `INSERT INTO ai_stage_case_ops(thread_id, local_id, version_id, case_id, op, payload, summary)
       VALUES ('batch-b2', 'manual-op', $1, $2, 'update_step', $3::jsonb, 'x')`,
      [versionId, caseId, JSON.stringify({ action: 'update_step', caseId, stepId: steps[0]!.id, compiled: [{ kind: 'click' }] })],
    );
    const { materializeStagedOps } = await import('../src/execute/batchSolidify.js');
    await expect(materializeStagedOps('batch-b2', caseId)).rejects.toThrow('固化工件缺失');
    // manual-op 仍在、compiled 未动
    const ops = await pool.query(`SELECT local_id FROM ai_stage_case_ops WHERE thread_id = 'batch-b2'`);
    expect(ops.rows).toHaveLength(1);
    expect((await stepRows(caseId))[0]!.compiled).toBeNull();
  });
});

describe('runSolidifyBatchCaseJob', () => {
  it('双绿：solidifying → verifying → passed，verifyResult 落行', async () => {
    const caseId = await seedCase();
    const steps = await stepRows(caseId);
    const batchId = await seedBatch([caseId]);
    await mockSolidify(stageSolidifyOps(caseId, steps.map((s) => s.id), [{ kind: 'click', locator: [{ strategy: 'css', value: '#del' }] }]));
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    vi.mocked(buildVerifyCaseTool).mockReturnValue({
      execute: async () => ({ ok: true, data: JSON.stringify({ result: 'passed', replay: { result: 'passed' } }) }),
    } as never);
    const { runSolidifyBatchCaseJob } = await import('../src/execute/batchSolidify.js');
    await runSolidifyBatchCaseJob({ batchId, caseId });
    const row = await batchRow(batchId, caseId);
    expect(row.status).toBe('passed');
    expect(row.error).toBeNull();
    expect(row.verify_result).toMatchObject({ result: 'passed' });
    expect(row.solidify_result).toEqual([{ order: 1, status: 'solidified' }]);
    expect((await stepRows(caseId))[0]!.compiled).toEqual([{ kind: 'click', locator: [{ strategy: 'css', value: '#del' }] }]);
    // 合成 ctx：liveView=false 传给工具工厂（job 建构的 ctx 不进这里——工厂入参由工具自己校验，此处只看结果）
  });

  it('solidify 失败（result=failed）→ solidify_failed，不落库不验收（原子语义）', async () => {
    const caseId = await seedCase();
    const batchId = await seedBatch([caseId]);
    await mockSolidify(async () => ({
      ok: true,
      data: JSON.stringify({ result: 'failed', failure: { error: '保存按钮不可点击' } }),
    }));
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const { runSolidifyBatchCaseJob } = await import('../src/execute/batchSolidify.js');
    await runSolidifyBatchCaseJob({ batchId, caseId });
    const row = await batchRow(batchId, caseId);
    expect(row.status).toBe('solidify_failed');
    expect(row.error).toBe('保存按钮不可点击');
    expect(buildVerifyCaseTool).not.toHaveBeenCalled(); // 未进验收
    expect((await stepRows(caseId))[0]!.compiled).toBeNull(); // 未落库
  });

  it('verify 失败 → verify_failed 但 DSL 已保留（决策：保留 DSL + 标记失败）', async () => {
    const caseId = await seedCase();
    const steps = await stepRows(caseId);
    const batchId = await seedBatch([caseId]);
    await mockSolidify(stageSolidifyOps(caseId, steps.map((s) => s.id), [{ kind: 'click', locator: [{ strategy: 'css', value: '#del' }] }]));
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    vi.mocked(buildVerifyCaseTool).mockReturnValue({
      execute: async () => ({
        ok: true,
        data: JSON.stringify({ result: 'failed', failure: { failureReason: 'ReplayDivergence', humanMessage: '所有定位候选均未命中' } }),
      }),
    } as never);
    const { runSolidifyBatchCaseJob } = await import('../src/execute/batchSolidify.js');
    await runSolidifyBatchCaseJob({ batchId, caseId });
    const row = await batchRow(batchId, caseId);
    expect(row.status).toBe('verify_failed');
    expect(row.error).toBe('所有定位候选均未命中');
    expect(row.verify_result).toMatchObject({ failure: { failureReason: 'ReplayDivergence' } });
    expect((await stepRows(caseId))[0]!.compiled).toEqual([{ kind: 'click', locator: [{ strategy: 'css', value: '#del' }] }]); // DSL 保留
  });

  it('verify ok:false（如全 aiTask 用例被 mechanical 拒绝）→ verify_failed 带 error', async () => {
    const caseId = await seedCase();
    const steps = await stepRows(caseId);
    const batchId = await seedBatch([caseId]);
    await mockSolidify(stageSolidifyOps(caseId, steps.map((s) => s.id), [{ kind: 'aiTask', instruction: '观察' }]));
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    vi.mocked(buildVerifyCaseTool).mockReturnValue({
      execute: async () => ({ ok: false, error: 'mechanical 模式要求用例含机械步骤（全部为视觉模式步骤），请改用 mode="full"' }),
    } as never);
    const { runSolidifyBatchCaseJob } = await import('../src/execute/batchSolidify.js');
    await runSolidifyBatchCaseJob({ batchId, caseId });
    const row = await batchRow(batchId, caseId);
    expect(row.status).toBe('verify_failed');
    expect(row.error).toContain('mechanical');
  });

  it('solidify 工具抛异常 → 兜底 solidify_failed（行不留 running）', async () => {
    const caseId = await seedCase();
    const batchId = await seedBatch([caseId]);
    await mockSolidify(async () => { throw new Error('chromium 崩了'); });
    const { runSolidifyBatchCaseJob } = await import('../src/execute/batchSolidify.js');
    await runSolidifyBatchCaseJob({ batchId, caseId });
    const row = await batchRow(batchId, caseId);
    expect(row.status).toBe('solidify_failed');
    expect(row.error).toContain('chromium 崩了');
    expect(row.finished_at ?? null).not.toBeNull();
  });

  it('重入守卫：步骤已全 compiled（materialize 后崩溃重试）→ 跳过 solidify 直接验收', async () => {
    const caseId = await seedCase({
      steps: [{ instruction: '点击删除按钮', compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#del' }] }] }],
    });
    const batchId = await seedBatch([caseId]);
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
    const { runSolidifyBatchCaseJob } = await import('../src/execute/batchSolidify.js');
    vi.mocked(buildSolidifyCaseTool).mockReturnValue({
      execute: async () => { throw new Error('不该被调用'); },
    } as never);
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    vi.mocked(buildVerifyCaseTool).mockReturnValue({
      execute: async () => ({ ok: true, data: JSON.stringify({ result: 'passed' }) }),
    } as never);
    await runSolidifyBatchCaseJob({ batchId, caseId });
    expect(buildSolidifyCaseTool).not.toHaveBeenCalled();
    expect((await batchRow(batchId, caseId)).status).toBe('passed');
  });
});

/** 轮询等待批量行落到期望终态（路由 inline 回落是 fire-and-forget，响应返回时 job 还在跑）。 */
async function waitForRow(batchId: string, caseId: string, expected: 'passed', timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const row = await batchRow(batchId, caseId);
    if (row.status === expected) return;
    if (['solidify_failed', 'materialize_failed', 'verify_failed'].includes(row.status)) {
      throw new Error(`job 落到 ${row.status} 而非 ${expected}: ${row.error}`);
    }
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：行仍为 ${row.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('routes: batch-solidify', () => {
  it('部分合格 → 200 建批次 + 入队执行（inline 回落）；rejected 带人读原因', async () => {
    const okCase = await seedCase();
    const badCase = await seedCase({ steps: [{ instruction: '已固化', compiled: [{ kind: 'click' }] }] });
    const steps = await stepRows(okCase);
    await mockSolidify(stageSolidifyOps(okCase, steps.map((s) => s.id), [{ kind: 'click', locator: [{ strategy: 'css', value: '#del' }] }]));
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    vi.mocked(buildVerifyCaseTool).mockReturnValue({
      execute: async () => ({ ok: true, data: JSON.stringify({ result: 'passed' }) }),
    } as never);
    const r = await request(app).post('/api/cases/batch-solidify').send({ caseIds: [okCase, badCase] });
    expect(r.status).toBe(200);
    expect(r.body.batchId).toBeTruthy();
    expect(r.body.accepted).toEqual([okCase]);
    expect(r.body.rejected).toEqual([{ caseId: badCase, reason: expect.stringContaining('已有固化步骤') }]);
    // inline 回落的 job 跑完：DSL 落库 + 行 passed
    await waitForRow(r.body.batchId, okCase, 'passed');
    expect((await stepRows(okCase))[0]!.compiled).toEqual([{ kind: 'click', locator: [{ strategy: 'css', value: '#del' }] }]);
    // 进度查询：passed
    const status = await request(app).get(`/api/cases/solidify-batches/${r.body.batchId as string}`);
    expect(status.body).toMatchObject({ status: 'passed', total: 1, passed: 1, failed: 0, running: 0 });
  });

  it('全部被拒 → 200 + batchId=null 不建批次（前端才能读到 rejected 明细）', async () => {
    const mobile = await seedCase({ platform: 'mobile' });
    const compiled = await seedCase({ steps: [{ instruction: 'x', compiled: [{ kind: 'click' }] }] });
    const r = await request(app).post('/api/cases/batch-solidify').send({ caseIds: [mobile, compiled] });
    expect(r.status).toBe(200);
    expect(r.body.batchId).toBeNull();
    expect(r.body.rejected).toHaveLength(2);
    const batches = await pool.query(`SELECT count(*)::int AS n FROM solidify_batches`);
    expect(batches.rows[0]!.n).toBe(0);
  });

  it('GET solidify-batches/:id 读时派生 running/partial/passed + title join；未知 id 404', async () => {
    const c1 = await seedCase();
    const c2 = await seedCase();
    const c3 = await seedCase();
    const batchId = randomUUID();
    await pool.query(`INSERT INTO solidify_batches(id, project_id) VALUES ($1, $2)`, [batchId, projectId]);
    for (const [cid, st] of [[c1, 'passed'], [c2, 'verify_failed'], [c3, 'queued']] as const) {
      await pool.query(`INSERT INTO solidify_batch_cases(batch_id, case_id, status) VALUES ($1, $2, $3)`, [batchId, cid, st]);
    }
    let r = await request(app).get(`/api/cases/solidify-batches/${batchId}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'running', total: 3, passed: 1, failed: 1, running: 1 });
    expect(r.body.cases).toEqual(expect.arrayContaining([
      expect.objectContaining({ caseId: c2, status: 'verify_failed', title: '批量固化用例' }),
    ]));
    await pool.query(`UPDATE solidify_batch_cases SET status = 'passed' WHERE batch_id = $1 AND case_id = $2`, [batchId, c3]);
    r = await request(app).get(`/api/cases/solidify-batches/${batchId}`);
    expect(r.body).toMatchObject({ status: 'partial', passed: 2, failed: 1, running: 0 });
    await pool.query(`UPDATE solidify_batch_cases SET status = 'passed' WHERE batch_id = $1 AND case_id = $2`, [batchId, c2]);
    r = await request(app).get(`/api/cases/solidify-batches/${batchId}`);
    expect(r.body).toMatchObject({ status: 'passed', passed: 3, failed: 0 });
    await expect(request(app).get(`/api/cases/solidify-batches/${randomUUID()}`)).resolves.toMatchObject({ status: 404 });
  });

  it('列表固化进度回填 + ?solidified=none 筛选（无步骤用例不算未固化）', async () => {
    const solidified = await seedCase({ steps: [{ instruction: 'a', compiled: [{ kind: 'click' }] }] });
    const pending = await seedCase({ steps: [{ instruction: 'b' }] });
    const noSteps = await seedCase({ steps: [] });
    let r = await request(app).get(`/api/cases?groupId=${groupId}&solidified=none`);
    expect(r.status).toBe(200);
    expect(r.body.map((x: { id: string }) => x.id)).toEqual([pending]);
    expect(r.body[0]).toMatchObject({ stepsTotal: 1, stepsCompiled: 0 });
    r = await request(app).get(`/api/cases?groupId=${groupId}`);
    const byId = new Map(r.body.map((x: { id: string; stepsTotal: number; stepsCompiled: number }) => [x.id, x]));
    expect(byId.get(solidified)).toMatchObject({ stepsTotal: 1, stepsCompiled: 1 });
    expect(byId.get(pending)).toMatchObject({ stepsTotal: 1, stepsCompiled: 0 });
    expect(byId.get(noSteps)).toMatchObject({ stepsTotal: 0, stepsCompiled: 0 });
  });
});
