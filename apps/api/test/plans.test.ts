import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject, seedOtherProductLine } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { plansRoute } = await import('../src/routes/plans.js');
  const { planRunsRoute } = await import('../src/routes/planRuns.js');
  const { executionsRoute } = await import('../src/routes/executions.js');
  const { casesRoute } = await import('../src/routes/cases.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  // 注入种子组织管理员身份（跳过真实登录；可见性判定依赖 managerOrgPaths 子树）。
  // helpers/auth 依赖 src 服务链（连带加载 db client），须等 DATABASE_URL 指向测试容器后再动态加载。
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(userId, username, orgId, orgPath);
    next();
  });
  app.use('/api/projects/:projectId/plans', plansRoute);
  app.use('/api/plans', plansRoute);
  app.use('/api/plan-runs', planRunsRoute);
  app.use('/api/executions', executionsRoute);
  app.use('/api/cases', casesRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

async function makeCase(groupId: string, versionId: string, title: string): Promise<string> {
  const c = await request(app).post('/api/cases').send({ title, groupId, versionId });
  return c.body.id as string;
}

describe('execution plans', () => {
  it('create/list under project', async () => {
    const { projectId, versionId } = await seedProject(pool);
    const created = await request(app)
      .post(`/api/projects/${projectId}/plans`)
      .send({ name: '预发冒烟', environment: '预发', versionId });
    expect(created.status).toBe(200);
    const list = await request(app).get(`/api/projects/${projectId}/plans`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].name).toBe('预发冒烟');
    expect(list.body[0].caseCount).toBe(0);
  });

  it('PUT group cases sets ordered list, detail returns cases in order', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P', versionId });
    const c1 = await makeCase(groupId, versionId, 'c1');
    const c2 = await makeCase(groupId, versionId, 'c2');
    const g = await request(app).post(`/api/plans/${plan.body.id}/groups`).send({ name: 'G' });
    const r = await request(app).put(`/api/plans/${plan.body.id}/groups/${g.body.id}/cases`).send({ caseIds: [c2, c1] });
    expect(r.status).toBe(200);
    const detail = await request(app).get(`/api/plans/${plan.body.id}`);
    expect(detail.body.cases.map((c: { id: string }) => c.id)).toEqual([c2, c1]);
  });

  it('PUT group cases rejects cross-product-line case with 409', async () => {
    // R2 起项目无组织列，计划的成员范围是「计划所在项目 + 同产品线的兄弟项目」。
    // 所以要 409 必须让那条外案落在**另一条**产品线上（同线内引用是合法的）。
    const a = await seedProject(pool);
    const plan = await request(app).post(`/api/projects/${a.projectId}/plans`).send({ name: 'P', versionId: a.versionId });
    const otherLineId = await seedOtherProductLine(pool);
    const b = await seedProject(pool, { productLineId: otherLineId });
    const foreign = await makeCase(b.groupId, b.versionId, 'foreign');
    const g = await request(app).post(`/api/plans/${plan.body.id}/groups`).send({ name: 'G' });
    const r = await request(app).put(`/api/plans/${plan.body.id}/groups/${g.body.id}/cases`).send({ caseIds: [foreign] });
    expect(r.status).toBe(409);
  });

  it('PATCH renames, DELETE removes', async () => {
    const { projectId, versionId } = await seedProject(pool);
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P', versionId });
    const patched = await request(app).patch(`/api/plans/${plan.body.id}`).send({ name: 'P2' });
    expect(patched.body.name).toBe('P2');
    const deleted = await request(app).delete(`/api/plans/${plan.body.id}`);
    expect(deleted.status).toBe(200);
  });

  it('run creates plan_run row and returns runId', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'run', versionId });
    const c1 = await makeCase(groupId, versionId, 'r1');
    await request(app).post(`/api/plans/${plan.body.id}/cases`).send({ caseIds: [c1] });
    const r = await request(app).post(`/api/plans/${plan.body.id}/run`);
    expect(r.status).toBe(200);
    expect(typeof r.body.runId).toBe('string');
    const detail = await request(app).get(`/api/plan-runs/${r.body.runId}`);
    expect(detail.body.planId).toBe(plan.body.id);
    expect(detail.body.status).toMatch(/running|passed|failed|cancelled/);
  });
});

describe('plan execution extras', () => {
  it('POST/PATCH persists strategy/rcaEnabled；计划级 environmentId/loginPrepare 被剥离不再接受', async () => {
    const { projectId, versionId } = await seedProject(pool);
    const r = await request(app)
      .post(`/api/projects/${projectId}/plans`)
      .send({
        name: 'P',
        versionId,
        strategy: 'fail_fast',
        rcaEnabled: true,
        environment: '预发',
        environmentId: randomUUID(),
        loginPrepare: { enabled: true, caseId: randomUUID(), unauthorizedKeywords: ['请先登录'] },
      });
    expect(r.status).toBe(200);
    const planId = r.body.id as string;
    const detail = await request(app).get(`/api/plans/${planId}`);
    expect(detail.body.strategy).toBe('fail_fast');
    expect(detail.body.rcaEnabled).toBe(true);
    // 环境/登录字段由 zod 剥离,不再落计划(计划级列已删,响应不再携带;组级配置走 /groups 端点)
    expect(detail.body.loginPrepareEnabled).toBeUndefined();
    expect(detail.body.loginCaseId).toBeUndefined();
    expect(detail.body.environment).toBeUndefined();
    expect(detail.body.environmentId).toBeUndefined();

    const patch = await request(app)
      .patch(`/api/plans/${planId}`)
      .send({ name: 'P2', strategy: 'run_all', environmentId: randomUUID(), loginPrepare: { enabled: true } });
    expect(patch.status).toBe(200);
    expect(patch.body.name).toBe('P2');
    expect(patch.body.strategy).toBe('run_all');
    expect(patch.body.loginPrepareEnabled).toBeUndefined();
    expect(patch.body.environmentId).toBeUndefined();
  });

  it('PUT /plans/:id/cases/order 组内重排（必传 groupId）', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P', versionId });
    const c1 = await makeCase(groupId, versionId, 'c1');
    const c2 = await makeCase(groupId, versionId, 'c2');
    const c3 = await makeCase(groupId, versionId, 'c3');
    await request(app).post(`/api/plans/${plan.body.id}/cases`).send({ caseIds: [c1, c2, c3] });
    const d0 = await request(app).get(`/api/plans/${plan.body.id}`);
    const gid = d0.body.groups[0].id as string;
    // 缺 groupId → 400（zod 校验失败）
    const noGroup = await request(app).put(`/api/plans/${plan.body.id}/cases/order`).send({ caseIds: [c3, c1, c2] });
    expect(noGroup.status).toBe(400);
    const r = await request(app).put(`/api/plans/${plan.body.id}/cases/order`).send({ groupId: gid, caseIds: [c3, c1, c2] });
    expect(r.status).toBe(200);
    const detail = await request(app).get(`/api/plans/${plan.body.id}`);
    expect(detail.body.cases.map((c: { id: string }) => c.id)).toEqual([c3, c1, c2]);
  });

  it('组登录准备无来源（无登录用例、无组环境）→ 422 login_case_required 且报组名', async () => {
    const { projectId, versionId } = await seedProject(pool);
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P', versionId });
    const g = await request(app)
      .post(`/api/plans/${plan.body.id}/groups`)
      .send({ name: '登录组', loginPrepare: { enabled: true } });
    expect(g.status).toBe(200);
    const r = await request(app).post(`/api/plans/${plan.body.id}/run`);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('login_case_required');
    expect(r.body.message).toContain('登录组');
  });

  // 0041 起登录凭据并入 web 对象:enqueue 的自登录源判定查「组环境的默认 web 服务对象」内嵌凭证。
  it('组登录无登录用例:组环境默认 web 对象带内嵌凭据 → run 通过 enqueue（200）', async () => {
    const { projectId, versionId } = await seedProject(pool);
    const { encrypt } = await import('../src/lib/secret-crypto.js');
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
    const enc = encrypt('p@ss');
    const env = await pool.query(
      `INSERT INTO test_environments(project_id, name) VALUES ($1, 'E') RETURNING id`, [projectId],
    );
    await pool.query(
      `INSERT INTO environment_objects(environment_id, object_type, label, payload, is_default) VALUES ($1, 'web', '默认', $2::jsonb, true)`,
      [env.rows[0]!.id, JSON.stringify({
        name: 'web', scheme: 'http', host: 'env.example', user: 'u',
        secret: { c: enc.ciphertext.toString('base64'), i: enc.iv.toString('base64'), t: enc.tag.toString('base64') },
      })],
    );
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P', versionId });
    const g = await request(app)
      .post(`/api/plans/${plan.body.id}/groups`)
      .send({ name: 'G', environmentId: env.rows[0]!.id, loginPrepare: { enabled: true } });
    expect(g.status).toBe(200);
    const r = await request(app).post(`/api/plans/${plan.body.id}/run`);
    expect(r.status).toBe(200);
    // 等后台 run 收敛，避免与 afterAll 的 pool.end 竞争
    for (let i = 0; i < 50; i++) {
      const detail = await request(app).get(`/api/plan-runs/${r.body.runId}`);
      if (detail.body.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, 30_000);

  it('组登录无登录用例:组环境默认 web 对象无内嵌凭据 → run 422 login_case_required', async () => {
    const { projectId, versionId } = await seedProject(pool);
    const env = await pool.query(
      `INSERT INTO test_environments(project_id, name) VALUES ($1, 'E') RETURNING id`, [projectId],
    );
    await pool.query(
      `INSERT INTO environment_objects(environment_id, object_type, label, payload, is_default) VALUES ($1, 'web', '默认', '{"name":"web","scheme":"http","host":"env.example"}', true)`,
      [env.rows[0]!.id],
    );
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P', versionId });
    const g = await request(app)
      .post(`/api/plans/${plan.body.id}/groups`)
      .send({ name: '空凭据组', environmentId: env.rows[0]!.id, loginPrepare: { enabled: true } });
    expect(g.status).toBe(200);
    const r = await request(app).post(`/api/plans/${plan.body.id}/run`);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('login_case_required');
    expect(r.body.message).toContain('空凭据组');
  }, 30_000);

  it('GET /executions returns mixed entries with kind=case or kind=plan', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P', versionId });
    const c1 = await makeCase(groupId, versionId, 'c1');
    await request(app).post(`/api/plans/${plan.body.id}/cases`).send({ caseIds: [c1] });
    await request(app).post(`/api/plans/${plan.body.id}/run`);
    const list = await request(app).get(`/api/executions?projectId=${projectId}&kind=all`);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    const kinds = new Set(list.body.map((e: { kind: string }) => e.kind));
    expect(kinds.has('plan')).toBe(true);
  });

  it('plan 运行中成员用例（report 未回填）不出现在执行历史；回填后仍不出现；手动运行照常显示', async () => {
    // 回归：runCase 一开跑就插 report，report_id 到用例跑完才回填 plan_run_cases——瞬态窗口内
    // report 无 plan 链接，登录用例又排在最前跑，最容易让用户在执行历史里看到"长得像独立执行"的行。
    // plan_run_cases 行以 status=running 先行存在，执行历史应据此精确排除运行中成员的报告。
    const { projectId, groupId, versionId } = await seedProject(pool);
    const member = await makeCase(groupId, versionId, 'plan-member');
    const manual = await makeCase(groupId, versionId, 'manual-run');
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P', versionId });
    const planId = plan.body.id as string;
    // 构造与 runPlan 一致的运行中 shape：plan_runs(running) + member 的 running report + 未回填的 member 行
    const run = await pool.query(
      `INSERT INTO plan_runs(plan_id, project_id, status, strategy) VALUES ($1, $2, 'running', 'run_all') RETURNING id`,
      [planId, projectId],
    );
    const runId = run.rows[0].id as string;
    const manualRep = await pool.query(
      `INSERT INTO reports(case_id, status, step_results) VALUES ($1, 'passed', '[]'::jsonb) RETURNING id`,
      [manual],
    );
    const memberRep = await pool.query(
      `INSERT INTO reports(case_id, status, step_results) VALUES ($1, 'running', '[]'::jsonb) RETURNING id`,
      [member],
    );
    await pool.query(
      `INSERT INTO plan_run_cases(plan_run_id, case_id, "order", status, step_kind) VALUES ($1, $2, 1, 'running', 'business')`,
      [runId, member],
    );

    // 瞬态窗口：运行中的成员报告被排除，手动运行不受影响
    const list1 = await request(app).get(`/api/executions?projectId=${projectId}&kind=case`);
    expect(list1.status).toBe(200);
    const ids1 = list1.body.map((e: { id: string }) => e.id);
    expect(ids1).not.toContain(memberRep.rows[0].id);
    expect(ids1).toContain(manualRep.rows[0].id);

    // 执行完成：report_id 回填 + 状态收敛 → 既有链接过滤继续排除（无缝衔接，无第二个泄漏窗口）
    await pool.query(
      `UPDATE plan_run_cases SET status = 'passed', report_id = $1, finished_at = now()
       WHERE plan_run_id = $2 AND case_id = $3`,
      [memberRep.rows[0].id, runId, member],
    );
    await pool.query(`UPDATE reports SET status = 'passed' WHERE id = $1`, [memberRep.rows[0].id]);
    const list2 = await request(app).get(`/api/executions?projectId=${projectId}&kind=case`);
    const ids2 = list2.body.map((e: { id: string }) => e.id);
    expect(ids2).not.toContain(memberRep.rows[0].id);
    expect(ids2).toContain(manualRep.rows[0].id);
  });

  it('caseId 深链在 plan tab 上继续过滤：只列出把该用例作为成员跑过的计划运行', async () => {
    // 回归：用例详情页「查看报告」深链带 caseId 进入报告页（默认 tab=case）。用户切到「计划运行」
    // tab 时 caseId 必须继续生效，否则 URL 里的过滤器静默失效、页面退化成全项目计划列表，
    // 用户会误以为看到的就是该用例参与过的运行。
    const { projectId, groupId, versionId } = await seedProject(pool);
    const member = await makeCase(groupId, versionId, 'deep-linked-member');
    const other = await makeCase(groupId, versionId, 'unrelated-case');
    const planA = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'PA', versionId });
    const planB = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'PB', versionId });
    const runA = await pool.query(
      `INSERT INTO plan_runs(plan_id, project_id, status, strategy) VALUES ($1, $2, 'passed', 'run_all') RETURNING id`,
      [planA.body.id, projectId],
    );
    const runB = await pool.query(
      `INSERT INTO plan_runs(plan_id, project_id, status, strategy) VALUES ($1, $2, 'passed', 'run_all') RETURNING id`,
      [planB.body.id, projectId],
    );
    await pool.query(
      `INSERT INTO plan_run_cases(plan_run_id, case_id, "order", status, step_kind) VALUES ($1, $2, 1, 'passed', 'business')`,
      [runA.rows[0].id, member],
    );
    await pool.query(
      `INSERT INTO plan_run_cases(plan_run_id, case_id, "order", status, step_kind) VALUES ($1, $2, 1, 'passed', 'business')`,
      [runB.rows[0].id, other],
    );

    const filtered = await request(app).get(`/api/executions?projectId=${projectId}&kind=plan&caseId=${member}`);
    expect(filtered.status).toBe(200);
    const ids = filtered.body.map((e: { id: string }) => e.id);
    expect(ids).toContain(runA.rows[0].id);
    expect(ids).not.toContain(runB.rows[0].id);

    // 不带 caseId 时两个计划运行都在——证明上面确实是过滤而非"只返回一条"
    const unfiltered = await request(app).get(`/api/executions?projectId=${projectId}&kind=plan`);
    const allIds = unfiltered.body.map((e: { id: string }) => e.id);
    expect(allIds).toContain(runA.rows[0].id);
    expect(allIds).toContain(runB.rows[0].id);

    // 该用例从未作为成员跑过时，过滤结果为空而非回退到全量
    const never = await makeCase(groupId, versionId, 'never-in-plan');
    const none = await request(app).get(`/api/executions?projectId=${projectId}&kind=plan&caseId=${never}`);
    expect(none.status).toBe(200);
    expect(none.body).toHaveLength(0);
  });

  it('fail_fast: first case fails → remaining cases skipped, plan_run.status=failed', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    const c1 = await makeCase(groupId, versionId, 'c1');
    const c2 = await makeCase(groupId, versionId, 'c2');
    const c3 = await makeCase(groupId, versionId, 'c3');
    const plan = await request(app)
      .post(`/api/projects/${projectId}/plans`)
      .send({ name: 'P', versionId, strategy: 'fail_fast' });
    await request(app).post(`/api/plans/${plan.body.id}/cases`).send({ caseIds: [c1, c2, c3] });
    // 两级失败语义：组内跳过由组级 fail_fast 决定（计划级只在组边界评估）
    const detail0 = await request(app).get(`/api/plans/${plan.body.id}`);
    const firstGroup = detail0.body.groups[0] as { id: string };
    await request(app).patch(`/api/plans/${plan.body.id}/groups/${firstGroup.id}`).send({ failFast: true });

    // 强制的现在是第一条：forceFail 在 CDP 前短路，行为与有无 chromium 环境无关
    process.env.FORCE_FAIL_CASE_IDS = c1;
    try {
      const r = await request(app).post(`/api/plans/${plan.body.id}/run`);
      expect(r.status).toBe(200);
      const runId = r.body.runId as string;

      // 等待 plan_run 收敛到终态
      let detail: { body: { status: string; failedCases: number; skippedCases: number; passedCases: number; cases: Array<{ order: number; status: string }> } };
      for (let i = 0; i < 50; i++) {
        detail = await request(app).get(`/api/plan-runs/${runId}`);
        if (detail!.body.status !== 'running') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(detail!.body.status).toBe('failed');
      expect(detail!.body.failedCases).toBe(1);
      expect(detail!.body.skippedCases).toBe(2);
      expect(detail!.body.passedCases).toBe(0);
      const byOrder = new Map(detail!.body.cases.map((c) => [c.order, c.status]));
      expect(byOrder.get(1)).toBe('failed');
      expect(byOrder.get(2)).toBe('skipped');
      expect(byOrder.get(3)).toBe('skipped');
    } finally {
      delete process.env.FORCE_FAIL_CASE_IDS;
    }
  });

  it('plan run 成员用例落真实执行耗时（durationMs 不再 NULL/0）', async () => {
    // 回归：业务用例收尾时从不写 plan_run_cases.duration_ms（NULL → 前端 c.durationMs ?? 0 显示 0 ms），
    // 登录用例写死 0 —— 计划运行时间线的「用例耗时」列恒为 0。修复后按 runCase 实际执行时长回填。
    const { projectId, groupId, versionId } = await seedProject(pool);
    const c1 = await makeCase(groupId, versionId, 'c1');
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P', versionId });
    await request(app).post(`/api/plans/${plan.body.id}/cases`).send({ caseIds: [c1] });

    const r = await request(app).post(`/api/plans/${plan.body.id}/run`);
    expect(r.status).toBe(200);
    const runId = r.body.runId as string;

    let detail: { body: { status: string; cases: Array<{ status: string; durationMs: number | null }> } };
    for (let i = 0; i < 50; i++) {
      detail = await request(app).get(`/api/plan-runs/${runId}`);
      if (detail!.body.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(detail!.body.status).not.toBe('running');
    const row = detail!.body.cases[0]!;
    // 用例真实执行过（无环境配置 → failed report，但已跑完收尾）：耗时必须是正数而非 NULL/0
    expect(typeof row.durationMs).toBe('number');
    expect(row.durationMs!).toBeGreaterThan(0);
  });

  it('deprecated cases skipped without execution, plan_run.status=passed', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    const c1 = await makeCase(groupId, versionId, 'c1');
    const c2 = await makeCase(groupId, versionId, 'c2');
    await request(app).patch(`/api/cases/${c1}`).send({ status: 'deprecated' });
    await request(app).patch(`/api/cases/${c2}`).send({ status: 'deprecated' });
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P', versionId });
    await request(app).post(`/api/plans/${plan.body.id}/cases`).send({ caseIds: [c1, c2] });

    const r = await request(app).post(`/api/plans/${plan.body.id}/run`);
    expect(r.status).toBe(200);
    const runId = r.body.runId as string;

    let detail: { body: { status: string; failedCases: number | null; skippedCases: number | null; passedCases: number | null; cases: Array<{ order: number; status: string }> } };
    for (let i = 0; i < 50; i++) {
      detail = await request(app).get(`/api/plan-runs/${runId}`);
      if (detail!.body.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(detail!.body.status).toBe('passed');
    expect(detail!.body.skippedCases).toBe(2);
    expect(detail!.body.passedCases).toBe(0);
    const byOrder = new Map(detail!.body.cases.map((c) => [c.order, c.status]));
    expect(byOrder.get(1)).toBe('skipped');
    expect(byOrder.get(2)).toBe('skipped');
  });

  it('cancel: cancel mid-run → plan_run.status=cancelled', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    const c1 = await makeCase(groupId, versionId, 'c1');
    const c2 = await makeCase(groupId, versionId, 'c2');
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P', versionId });
    await request(app).post(`/api/plans/${plan.body.id}/cases`).send({ caseIds: [c1, c2] });

    const r = await request(app).post(`/api/plans/${plan.body.id}/run`);
    expect(r.status).toBe(200);
    const runId = r.body.runId as string;

    // 立即 cancel；每条 case 执行极快，需在 finalize 之前命中
    const cancel = await request(app).post(`/api/plan-runs/${runId}/cancel`);
    expect(cancel.status).toBe(200);

    // 等待收敛
    let detail: { body: { status: string; cancelRequested: boolean } };
    for (let i = 0; i < 50; i++) {
      detail = await request(app).get(`/api/plan-runs/${runId}`);
      if (detail!.body.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(['cancelled', 'passed', 'failed']).toContain(detail!.body.status);
    expect(detail!.body.cancelRequested).toBe(true);
  });

  it('组登录 + 组内 incognito 用例 → 422 incognito_conflicts_with_login_prepare', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    const inc = await request(app).post('/api/cases').send({ title: 'inc', groupId, versionId, incognito: true });
    const login = await makeCase(groupId, versionId, 'login');
    const plan = await request(app)
      .post(`/api/projects/${projectId}/plans`)
      .send({ name: 'P', versionId });
    expect(plan.status).toBe(200);
    const g = await request(app)
      .post(`/api/plans/${plan.body.id}/groups`)
      .send({ name: 'G', loginPrepare: { enabled: true, caseId: login } });
    expect(g.status).toBe(200);
    await request(app).put(`/api/plans/${plan.body.id}/groups/${g.body.id}/cases`).send({ caseIds: [inc.body.id] });
    const r = await request(app).post(`/api/plans/${plan.body.id}/run`);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('incognito_conflicts_with_login_prepare');
    expect(r.body.message).toContain(inc.body.id);
  });

  it('组登录 + 组内 mobile 用例 → 422 login_prepare_skips_mobile 且报组名', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    const login = await makeCase(groupId, versionId, 'login');
    const mob = await makeCase(groupId, versionId, 'mob');
    // 直写列造 mobile shape（路由建 mobile 用例需整套 mobileOs/deviceTarget/appRef 配置）
    await pool.query(`UPDATE test_cases SET platform = 'mobile' WHERE id = $1`, [mob]);
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P', versionId });
    const g = await request(app)
      .post(`/api/plans/${plan.body.id}/groups`)
      .send({ name: '移动组', loginPrepare: { enabled: true, caseId: login } });
    expect(g.status).toBe(200);
    await request(app).put(`/api/plans/${plan.body.id}/groups/${g.body.id}/cases`).send({ caseIds: [mob] });
    const r = await request(app).post(`/api/plans/${plan.body.id}/run`);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('login_prepare_skips_mobile');
    expect(r.body.message).toContain('移动组');
  });

  it('allows run with incognito case when loginPrepare disabled', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    const inc = await request(app).post('/api/cases').send({ title: 'inc', groupId, versionId, incognito: true });
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P', versionId });
    await request(app).post(`/api/plans/${plan.body.id}/cases`).send({ caseIds: [inc.body.id] });
    const r = await request(app).post(`/api/plans/${plan.body.id}/run`);
    expect(r.status).toBe(200);
    expect(typeof r.body.runId).toBe('string');
    // 等待后台 run 收敛到终态，避免与 afterAll 的 pool.end 竞争
    for (let i = 0; i < 50; i++) {
      const detail = await request(app).get(`/api/plan-runs/${r.body.runId}`);
      if (detail.body.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });

  it('运行快照带 groups（全部组配置，按组序）；标量 login_prepare_enabled = 任一组开启（旧 UI 兼容）', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    const login = await makeCase(groupId, versionId, 'login');
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P', versionId });
    const g1 = await request(app).post(`/api/plans/${plan.body.id}/groups`).send({ name: 'G1' });
    const g2 = await request(app)
      .post(`/api/plans/${plan.body.id}/groups`)
      .send({ name: 'G2', loginPrepare: { enabled: true, caseId: login }, failFast: true });
    expect(g1.status).toBe(200);
    expect(g2.status).toBe(200);
    const r = await request(app).post(`/api/plans/${plan.body.id}/run`);
    expect(r.status).toBe(200);
    const row = await pool.query(
      `SELECT groups, login_prepare_enabled, login_case_id, detection_url FROM plan_runs WHERE id = $1`,
      [r.body.runId],
    );
    const groups = row.rows[0].groups as Array<{
      name: string; loginPrepareEnabled: boolean; loginCaseId: string | null; failFast: boolean;
    }>;
    expect(groups.map((g) => g.name)).toEqual(['G1', 'G2']);
    expect(groups[0]!.loginPrepareEnabled).toBe(false);
    expect(groups[1]!.loginPrepareEnabled).toBe(true);
    expect(groups[1]!.loginCaseId).toBe(login);
    expect(groups[1]!.failFast).toBe(true);
    // 旧 UI 兼容标量：任一组开启登录即 true；细粒度配置只在 groups 快照里
    expect(row.rows[0].login_prepare_enabled).toBe(true);
    expect(row.rows[0].login_case_id).toBeNull();
    expect(row.rows[0].detection_url).toBeNull();
    // 等后台 run 收敛，避免与 afterAll 的 pool.end 竞争
    for (let i = 0; i < 50; i++) {
      const detail = await request(app).get(`/api/plan-runs/${r.body.runId}`);
      if (detail.body.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, 30_000);
});

describe('plan case groups (HTTP)', () => {
  it('组端点全链路：建组→PATCH→409 删非空组→组排序→组内用例替换→POST cases 带 groupId→组内重排→跨组移动→越组 404', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P', versionId });
    const planId = plan.body.id as string;
    const c1 = await makeCase(groupId, versionId, 'c1');
    const c2 = await makeCase(groupId, versionId, 'c2');

    // 建组：order 递增
    const g1 = await request(app).post(`/api/plans/${planId}/groups`).send({ name: 'G1' });
    expect(g1.status).toBe(200);
    expect(g1.body.name).toBe('G1');
    expect(g1.body.order).toBe(1);
    const g2 = await request(app).post(`/api/plans/${planId}/groups`).send({ name: 'G2' });
    expect(g2.status).toBe(200);
    expect(g2.body.order).toBe(2);

    // PATCH 组：改组名 + failFast
    const patched = await request(app)
      .patch(`/api/plans/${planId}/groups/${g1.body.id}`)
      .send({ name: 'G1x', failFast: true });
    expect(patched.status).toBe(200);
    expect(patched.body.name).toBe('G1x');
    expect(patched.body.failFast).toBe(true);

    // 组内用例整包替换
    const setCases = await request(app)
      .put(`/api/plans/${planId}/groups/${g1.body.id}/cases`)
      .send({ caseIds: [c1, c2] });
    expect(setCases.status).toBe(200);

    // 删非空组 → 409
    const del = await request(app).delete(`/api/plans/${planId}/groups/${g1.body.id}`);
    expect(del.status).toBe(409);
    expect(del.body.error).toBe('group_not_empty');

    // 组排序翻转，GET :id 验组序
    const reorderGroups = await request(app)
      .put(`/api/plans/${planId}/groups/order`)
      .send({ groupIds: [g2.body.id, g1.body.id] });
    expect(reorderGroups.status).toBe(200);
    const d1 = await request(app).get(`/api/plans/${planId}`);
    expect(d1.body.groups.map((g: { id: string }) => g.id)).toEqual([g2.body.id, g1.body.id]);

    // POST /cases 带 groupId → 追加到指定组（跨组重复合法）
    const add = await request(app)
      .post(`/api/plans/${planId}/cases`)
      .send({ caseIds: [c1], groupId: g2.body.id });
    expect(add.status).toBe(200);
    expect(add.body.added).toBe(1);

    // cases/order 组内重排：G1 [c1,c2] → [c2,c1]
    const reorderCases = await request(app)
      .put(`/api/plans/${planId}/cases/order`)
      .send({ groupId: g1.body.id, caseIds: [c2, c1] });
    expect(reorderCases.status).toBe(200);

    // 跨组移动：G1 的 c2 行 → G2 尾部
    const d2 = await request(app).get(`/api/plans/${planId}`);
    const g1Before = d2.body.groups.find((g: { id: string }) => g.id === g1.body.id);
    const c2Row = g1Before.cases.find((c: { id: string }) => c.id === c2);
    const mv = await request(app)
      .put(`/api/plans/${planId}/cases/move`)
      .send({ planCaseIds: [c2Row.planCaseId], toGroupId: g2.body.id });
    expect(mv.status).toBe(200);
    const d3 = await request(app).get(`/api/plans/${planId}`);
    const g1After = d3.body.groups.find((g: { id: string }) => g.id === g1.body.id);
    const g2After = d3.body.groups.find((g: { id: string }) => g.id === g2.body.id);
    expect(g1After.cases.map((c: { id: string }) => c.id)).toEqual([c1]);
    expect(g2After.cases.map((c: { id: string }) => c.id)).toEqual([c1, c2]);

    // 越组：用另一计划 id 打本计划的组 → 404 group_not_found
    const planB = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'PB', versionId });
    const cross = await request(app)
      .patch(`/api/plans/${planB.body.id}/groups/${g1.body.id}`)
      .send({ name: 'X' });
    expect(cross.status).toBe(404);
    expect(cross.body.error).toBe('group_not_found');
  });

  it('空组可直接删除', async () => {
    const { projectId, versionId } = await seedProject(pool);
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P', versionId });
    const g = await request(app).post(`/api/plans/${plan.body.id}/groups`).send({ name: 'G' });
    const del = await request(app).delete(`/api/plans/${plan.body.id}/groups/${g.body.id}`);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);
  });
});

describe('executions 数据集批次卷起', () => {
  /** 插入一条 report（可带批次键 / 行号 / 耗时 / 状态）。 */
  async function insertReport(
    caseId: string,
    opts: { batchId?: string; rowIndex?: number; status?: string; durationMs?: number } = {},
  ): Promise<string> {
    const r = await pool.query(
      `INSERT INTO reports(case_id, status, duration_ms, step_results, dataset_batch_id, dataset_row_index)
       VALUES ($1, $2, $3, '[]'::jsonb, $4, $5) RETURNING id`,
      [caseId, opts.status ?? 'passed', opts.durationMs ?? 100, opts.batchId ?? null, opts.rowIndex ?? null],
    );
    return r.rows[0].id as string;
  }

  it('同批 N 行卷起成一条：统计按全批、锚点为行号最小者', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    const c = await makeCase(groupId, versionId, 'dataset-case');
    const batchId = randomUUID();
    const r0 = await insertReport(c, { batchId, rowIndex: 0, status: 'passed', durationMs: 100 });
    const r1 = await insertReport(c, { batchId, rowIndex: 1, status: 'passed', durationMs: 200 });
    const r2 = await insertReport(c, { batchId, rowIndex: 2, status: 'failed', durationMs: 300 });

    const list = await request(app).get(`/api/executions?projectId=${projectId}&kind=case`);
    expect(list.status).toBe(200);
    const rows = list.body.filter((e: { kind: string }) => e.kind === 'case');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe(r0); // 锚点 = 行号最小者
    expect(row.status).toBe('failed'); // 有失败成员 → 整批 failed
    expect(row.batchSize).toBe(3);
    expect(row.batchPassed).toBe(2);
    expect(row.batchFailed).toBe(1);
    expect(row.durationMs).toBe(600); // 成员耗时之和
    expect(new Set(row.memberReportIds)).toEqual(new Set([r0, r1, r2]));
  });

  it('无批次的老报告各占一条、batchSize=1', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    const c = await makeCase(groupId, versionId, 'legacy-case');
    const a = await insertReport(c, { status: 'passed' });
    const b = await insertReport(c, { status: 'failed' });

    const list = await request(app).get(`/api/executions?projectId=${projectId}&kind=case`);
    const rows = list.body.filter((e: { kind: string }) => e.kind === 'case');
    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((e: { id: string }) => [e.id, e]));
    expect(byId.get(a)!.batchSize).toBe(1);
    expect(byId.get(a)!.datasetBatchId).toBeNull();
    expect(byId.get(b)!.batchSize).toBe(1);
  });

  it('两个不同批次各出一条，互不混合', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    const c = await makeCase(groupId, versionId, 'two-batches');
    const b1 = randomUUID();
    const b2 = randomUUID();
    await insertReport(c, { batchId: b1, rowIndex: 0 });
    await insertReport(c, { batchId: b1, rowIndex: 1 });
    await insertReport(c, { batchId: b2, rowIndex: 0 });

    const list = await request(app).get(`/api/executions?projectId=${projectId}&kind=case`);
    const rows = list.body.filter((e: { kind: string }) => e.kind === 'case');
    expect(rows).toHaveLength(2);
    const sizes = rows.map((e: { batchSize: number }) => e.batchSize).sort();
    expect(sizes).toEqual([1, 2]);
  });

  it('状态筛选命中批内任一成员即出现该批，统计仍按全批真实值', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    const c = await makeCase(groupId, versionId, 'filtered-batch');
    const batchId = randomUUID();
    await insertReport(c, { batchId, rowIndex: 0, status: 'passed' });
    await insertReport(c, { batchId, rowIndex: 1, status: 'passed' });
    await insertReport(c, { batchId, rowIndex: 2, status: 'failed' });

    // 只筛 failed：命中批内第 3 行，批本身出现
    const list = await request(app).get(`/api/executions?projectId=${projectId}&kind=case&statuses=failed`);
    expect(list.status).toBe(200);
    const rows = list.body.filter((e: { kind: string }) => e.kind === 'case');
    expect(rows).toHaveLength(1);
    // 统计按全批算：不能因为只命中失败行就把通过数报成 0
    expect(rows[0].batchSize).toBe(3);
    expect(rows[0].batchPassed).toBe(2);
    expect(rows[0].batchFailed).toBe(1);
    expect(rows[0].status).toBe('failed');
  });

  it('批成员挂在计划运行下时按计划成员排除口径剔除', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    const c = await makeCase(groupId, versionId, 'plan-linked-batch');
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P', versionId });
    const run = await pool.query(
      `INSERT INTO plan_runs(plan_id, project_id, status, strategy) VALUES ($1, $2, 'passed', 'run_all') RETURNING id`,
      [plan.body.id, projectId],
    );
    const batchId = randomUUID();
    const r0 = await insertReport(c, { batchId, rowIndex: 0 });
    const r1 = await insertReport(c, { batchId, rowIndex: 1 });
    // r1 挂到计划运行成员下 → 不进单用例执行历史
    await pool.query(
      `INSERT INTO plan_run_cases(plan_run_id, case_id, "order", status, step_kind, report_id)
       VALUES ($1, $2, 1, 'passed', 'business', $3)`,
      [run.rows[0].id, c, r1],
    );

    const list = await request(app).get(`/api/executions?projectId=${projectId}&kind=case`);
    const rows = list.body.filter((e: { kind: string }) => e.kind === 'case');
    expect(rows).toHaveLength(1);
    expect(rows[0].batchSize).toBe(1);
    expect(rows[0].memberReportIds).toEqual([r0]);
  });
});
