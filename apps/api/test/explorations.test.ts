import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';
// 类型导入编译期擦除（不触发模块加载）；helpers/auth 链到 auth.service → db/client，
// 模块加载即快照 DATABASE_URL，故必须在设好环境变量后动态 import。
import type { AuthUser } from '../src/services/auth.service.js';

// runner 打桩：真实实现会起 chromium + 调 LLM，路由测试只验契约与状态机。
const { runMock, removeShotsMock } = vi.hoisted(() => ({
  runMock: vi.fn(async (_input: { sessionId: string }) => undefined),
  removeShotsMock: vi.fn(async (_sessionId: string) => undefined),
}));
vi.mock('../src/execute/exploration.js', () => ({
  runExplorationSession: runMock,
  removeExplorationScreenshots: removeShotsMock,
}));

let pool: Pool;
let app: import('express').Express;
let projectId: string;
let versionId: string;
/** 种子项目的分组（升格用例的目标分组）。 */
let groupId: string;
/** 另一个项目的分组（跨项目升格应被拒）。 */
let otherGroupId: string;
let userId: string;
let username: string;
let orgId: string;
let orgPath: string;
/** 当前注入的登录身份（跨组织用例临时切换）。 */
let currentUser: AuthUser;
/** helpers/auth 的工厂（动态 import 取得，见 beforeAll 注释）。 */
let managerUserOf: typeof import('./helpers/auth.js').managerUserOf;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { explorationsRoute } = await import('../src/routes/explorations.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const auth = await import('./helpers/auth.js');
  managerUserOf = auth.managerUserOf;
  app = express();
  app.use(express.json());
  const seed = await seedOrg(pool);
  userId = seed.userId; username = seed.username; orgId = seed.orgId; orgPath = seed.orgPath;
  const seeded = await seedProject(pool);
  projectId = seeded.projectId; versionId = seeded.versionId; groupId = seeded.groupId;
  const other = await seedProject(pool);
  otherGroupId = other.groupId;
  currentUser = managerUserOf(userId, username, orgId, orgPath);
  app.use('/api', (req, _res, next) => {
    req.user = currentUser;
    next();
  });
  app.use('/api/explorations', explorationsRoute);
  app.use(errorHandler);
}, 60000);

afterAll(async () => {
  const { pool: p } = await import('../src/db/client.js');
  await p.end().catch(() => undefined);
  await pool.end();
});

const CHARTER = '探索用户管理页面的增删改查，报告所有异常行为与校验缺失。';

/** 建一条会话（落库直写，绕开 runner）。 */
async function insertSession(overrides: Record<string, unknown> = {}): Promise<string> {
  const r = await pool.query(
    `INSERT INTO exploration_sessions(project_id, version_id, title, charter, persona, status, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      projectId,
      versionId,
      (overrides.title as string) ?? '会话',
      (overrides.charter as string) ?? CHARTER,
      (overrides.persona as string) ?? 'qa',
      (overrides.status as string) ?? 'pending',
      userId,
    ],
  );
  return r.rows[0]!.id as string;
}

describe('POST /api/explorations - 建会话', () => {
  it('落库 pending + 默认标题取章程前 80 字 + 派发 runner', async () => {
    const r = await request(app).post('/api/explorations').send({ versionId, charter: CHARTER });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('pending');
    expect(r.body.persona).toBe('qa');
    expect(r.body.title).toBe(CHARTER.slice(0, 80));
    expect(runMock).toHaveBeenCalledWith({ sessionId: r.body.id });
  });

  it('章程过短 → 400 validation_failed；未知 persona → 400', async () => {
    const short = await request(app).post('/api/explorations').send({ versionId, charter: '太短' });
    expect(short.status).toBe(400);
    expect(short.body.error).toBe('validation_failed');
    const badPersona = await request(app).post('/api/explorations').send({ versionId, charter: CHARTER, persona: 'nope' });
    expect(badPersona.status).toBe(400);
  });

  it('版本不存在 → 404（不泄露项目存在性）', async () => {
    const r = await request(app).post('/api/explorations').send({ versionId: randomUUID(), charter: CHARTER });
    expect(r.status).toBe(404);
  });

  it('破坏性操作授权位：缺省 false（默认拒），显式 true 才落库', async () => {
    const dflt = await request(app).post('/api/explorations').send({ versionId, charter: CHARTER });
    expect(dflt.status).toBe(201);
    expect(dflt.body.allowDestructive).toBe(false);
    const row = (await pool.query(`SELECT allow_destructive FROM exploration_sessions WHERE id=$1`, [dflt.body.id])).rows[0]!;
    expect(row.allow_destructive).toBe(false);

    const granted = await request(app)
      .post('/api/explorations')
      .send({ versionId, charter: CHARTER, allowDestructive: true });
    expect(granted.status).toBe(201);
    expect(granted.body.allowDestructive).toBe(true);
    const row2 = (await pool.query(`SELECT allow_destructive FROM exploration_sessions WHERE id=$1`, [granted.body.id])).rows[0]!;
    expect(row2.allow_destructive).toBe(true);
  });

  it('故障注入授权位：缺省 false（默认拒），显式 true 才落库', async () => {
    const dflt = await request(app).post('/api/explorations').send({ versionId, charter: CHARTER });
    expect(dflt.status).toBe(201);
    expect(dflt.body.allowFaultInjection).toBe(false);
    const row = (await pool.query(`SELECT allow_fault_injection FROM exploration_sessions WHERE id=$1`, [dflt.body.id])).rows[0]!;
    expect(row.allow_fault_injection).toBe(false);

    const granted = await request(app)
      .post('/api/explorations')
      .send({ versionId, charter: CHARTER, allowFaultInjection: true });
    expect(granted.status).toBe(201);
    expect(granted.body.allowFaultInjection).toBe(true);
    const row2 = (await pool.query(`SELECT allow_fault_injection FROM exploration_sessions WHERE id=$1`, [granted.body.id])).rows[0]!;
    expect(row2.allow_fault_injection).toBe(true);
  });

  it('测试窗口两态：缺省 → null/null；成对给 → 落库；只给一个 → 400 window_required', async () => {
    const dflt = await request(app).post('/api/explorations').send({ versionId, charter: CHARTER });
    expect(dflt.status).toBe(201);
    const row = (await pool.query(`SELECT window_width, window_height FROM exploration_sessions WHERE id=$1`, [dflt.body.id])).rows[0]!;
    expect(row.window_width).toBeNull();
    expect(row.window_height).toBeNull();

    const custom = await request(app)
      .post('/api/explorations')
      .send({ versionId, charter: CHARTER, windowWidth: 1600, windowHeight: 900 });
    expect(custom.status).toBe(201);
    expect(custom.body.windowWidth).toBe(1600);
    expect(custom.body.windowHeight).toBe(900);

    const half = await request(app).post('/api/explorations').send({ versionId, charter: CHARTER, windowWidth: 1600 });
    expect(half.status).toBe(400);
    expect(half.body.error).toBe('window_required');
  });
});

describe('GET /api/explorations - 列表与详情', () => {
  it('按 versionId 过滤 + 附创建人', async () => {
    const id = await insertSession({ title: '列表用会话' });
    const r = await request(app).get(`/api/explorations?versionId=${versionId}`);
    expect(r.status).toBe(200);
    expect(r.body.items.some((s: { id: string }) => s.id === id)).toBe(true);
    expect(r.body.items[0].createdBy.username).toBe(username);
    expect(r.body.total).toBeGreaterThan(0);
  });

  it('列表附缺陷候选数（findingsCount）：有 findings 记数，无则 0', async () => {
    const withFindings = await insertSession({ title: '有缺陷候选的会话' });
    await insertFinding(withFindings);
    await insertFinding(withFindings, { order: 2 });
    const without = await insertSession({ title: '无缺陷候选的会话' });
    const r = await request(app).get(`/api/explorations?versionId=${versionId}`);
    expect(r.status).toBe(200);
    const counts = new Map<string, number>(
      r.body.items.map((s: { id: string; findingsCount: number }) => [s.id, s.findingsCount]),
    );
    expect(counts.get(withFindings)).toBe(2);
    expect(counts.get(without)).toBe(0);
  });

  it('详情返回会话 + findings（按 order 升序）', async () => {
    const id = await insertSession();
    await pool.query(
      `INSERT INTO exploration_findings(session_id, "order", title, description, severity, repro_steps)
       VALUES ($1, 2, '第二条', 'd2', 'P1', '[]'), ($1, 1, '第一条', 'd1', 'P2', '[]')`,
      [id],
    );
    const r = await request(app).get(`/api/explorations/${id}`);
    expect(r.status).toBe(200);
    expect(r.body.findings.map((f: { title: string }) => f.title)).toEqual(['第一条', '第二条']);
  });

  it('详情返回会话过程 steps（会话级留痕列，含查库摘要）', async () => {
    const id = await insertSession();
    await pool.query(`UPDATE exploration_sessions SET actions_trail=$2 WHERE id=$1`, [
      id,
      JSON.stringify([
        { type: 'navigate', target: 'http://127.0.0.1:56100/', ok: true },
        { type: 'sql', target: 'SELECT COUNT(*) FROM sa_asset', ok: true, detail: '1 行｜首行：cnt=20' },
        { type: 'sql', target: 'DELETE FROM sa_asset', ok: false, detail: '失败：只读守卫拒绝' },
      ]),
    ]);
    const r = await request(app).get(`/api/explorations/${id}`);
    expect(r.status).toBe(200);
    expect(r.body.steps).toHaveLength(3);
    expect(r.body.steps[1]).toEqual({
      type: 'sql',
      target: 'SELECT COUNT(*) FROM sa_asset',
      ok: true,
      detail: '1 行｜首行：cnt=20',
    });
    expect(r.body.steps[2].ok).toBe(false);
  });

  it('老会话（无会话级留痕）→ steps 回落为各 finding 留痕的合并', async () => {
    const id = await insertSession();
    await insertFinding(id, {
      order: 1,
      actionsTrail: [
        { type: 'click', target: '#save', ok: true },
        { type: 'sql', target: 'SELECT 1', ok: true, detail: '1 行' },
      ],
    });
    await insertFinding(id, {
      order: 2,
      actionsTrail: [{ type: 'navigate', target: 'http://127.0.0.1:56100/', ok: true }],
    });
    const r = await request(app).get(`/api/explorations/${id}`);
    expect(r.status).toBe(200);
    expect(r.body.steps.map((s: { type: string }) => s.type)).toEqual(['click', 'sql', 'navigate']);
    expect(r.body.steps[1].detail).toBe('1 行');
  });

  it('详情返回负面结果账本（已排除项 + 依据）', async () => {
    const id = await insertSession();
    await pool.query(`UPDATE exploration_sessions SET excluded_ledger=$2 WHERE id=$1`, [
      id,
      JSON.stringify([{ claim: '列表页无越权', evidence: '切用户后仍见自己数据' }]),
    ]);
    const r = await request(app).get(`/api/explorations/${id}`);
    expect(r.status).toBe(200);
    expect(r.body.excludedLedger).toEqual([{ claim: '列表页无越权', evidence: '切用户后仍见自己数据' }]);
  });

  it('跨组织用户看详情 → 404', async () => {
    const id = await insertSession();
    const outsiderOrgId = randomUUID();
    currentUser = managerUserOf(randomUUID(), 'outsider', outsiderOrgId, `/${outsiderOrgId}/`);
    const r = await request(app).get(`/api/explorations/${id}`);
    expect(r.status).toBe(404);
    currentUser = managerUserOf(userId, username, orgId, orgPath);
  });

  it('跨组织用户按 versionId 列列表 → 404（过滤也必须过可见性）', async () => {
    const outsiderOrgId = randomUUID();
    currentUser = managerUserOf(randomUUID(), 'outsider', outsiderOrgId, `/${outsiderOrgId}/`);
    const r = await request(app).get(`/api/explorations?versionId=${versionId}`);
    expect(r.status).toBe(404);
    currentUser = managerUserOf(userId, username, orgId, orgPath);
  });
});

/** 建一条 finding（落库直写）。 */
async function insertFinding(sessionId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const r = await pool.query(
    `INSERT INTO exploration_findings(session_id, "order", title, description, severity, repro_steps, actions_trail, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      sessionId,
      (overrides.order as number) ?? 1,
      (overrides.title as string) ?? '缺陷候选',
      (overrides.description as string) ?? '描述',
      (overrides.severity as string) ?? 'P2',
      JSON.stringify(overrides.reproSteps ?? [{ action: '点击删除按钮' }]),
      JSON.stringify(overrides.actionsTrail ?? [{ type: 'click', target: '.del', ok: true }]),
      (overrides.status as string) ?? 'pending',
    ],
  );
  return r.rows[0]!.id as string;
}

describe('取消与删除', () => {
  it('cancel 置位且幂等（重复调用仍 200）', async () => {
    const id = await insertSession({ status: 'running' });
    const first = await request(app).post(`/api/explorations/${id}/cancel`);
    expect(first.status).toBe(200);
    const row = (await pool.query(`SELECT cancel_requested FROM exploration_sessions WHERE id=$1`, [id])).rows[0]!;
    expect(row.cancel_requested).toBe(true);
    const second = await request(app).post(`/api/explorations/${id}/cancel`);
    expect(second.status).toBe(200);
  });

  it('running/pending 会话删除 → 409', async () => {
    const id = await insertSession({ status: 'running' });
    const r = await request(app).delete(`/api/explorations/${id}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('exploration_running');
  });

  it('已请求取消的 running 会话可删（执行器已死留下的孤儿会话不至于卡死）', async () => {
    const id = await insertSession({ status: 'running' });
    await request(app).post(`/api/explorations/${id}/cancel`);
    const r = await request(app).delete(`/api/explorations/${id}`);
    expect(r.status).toBe(200);
    const left = (await pool.query(`SELECT count(*)::int AS c FROM exploration_sessions WHERE id=$1`, [id])).rows[0]!.c;
    expect(left).toBe(0);
  });

  it('终态会话删除 → findings 级联删 + 截图目录清理', async () => {
    const id = await insertSession({ status: 'completed' });
    await pool.query(
      `INSERT INTO exploration_findings(session_id, "order", title, description, severity, repro_steps) VALUES ($1, 1, 'f', 'd', 'P2', '[]')`,
      [id],
    );
    const r = await request(app).delete(`/api/explorations/${id}`);
    expect(r.status).toBe(200);
    const left = (await pool.query(`SELECT count(*)::int AS c FROM exploration_findings WHERE session_id=$1`, [id])).rows[0]!.c;
    expect(left).toBe(0);
    expect(removeShotsMock).toHaveBeenCalledWith(id);
  });
});

describe('实时画面路由', () => {
  it('无活动画面源 → 404（路由已挂载且鉴权先行）', async () => {
    const id = await insertSession({ status: 'running' });
    const r = await request(app).get(`/api/explorations/${id}/live`);
    expect(r.status).toBe(404);
  });

  it('跨组织用户连画面 → 404（鉴权先于流）', async () => {
    const id = await insertSession({ status: 'running' });
    const outsiderOrgId = randomUUID();
    currentUser = managerUserOf(randomUUID(), 'outsider', outsiderOrgId, `/${outsiderOrgId}/`);
    const r = await request(app).get(`/api/explorations/${id}/live`);
    expect(r.status).toBe(404);
    currentUser = managerUserOf(userId, username, orgId, orgPath);
  });
});

describe('审阅 finding', () => {
  it('确认 → status=confirmed + 记录审阅人', async () => {
    const sessionId = await insertSession({ status: 'completed' });
    const fid = await insertFinding(sessionId);
    const r = await request(app).post(`/api/explorations/${sessionId}/findings/${fid}/review`).send({ decision: 'confirmed' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('confirmed');
    expect(r.body.reviewedBy).toBe(userId);
    expect(r.body.reviewedAt).toBeTruthy();
  });

  it('驳回 → status=dismissed', async () => {
    const sessionId = await insertSession({ status: 'completed' });
    const fid = await insertFinding(sessionId);
    const r = await request(app).post(`/api/explorations/${sessionId}/findings/${fid}/review`).send({ decision: 'dismissed' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('dismissed');
  });

  it('非 pending 再审 → 409；非法 decision → 400', async () => {
    const sessionId = await insertSession({ status: 'completed' });
    const fid = await insertFinding(sessionId, { status: 'confirmed' });
    const again = await request(app).post(`/api/explorations/${sessionId}/findings/${fid}/review`).send({ decision: 'dismissed' });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('already_reviewed');
    const bad = await request(app).post(`/api/explorations/${sessionId}/findings/${fid}/review`).send({ decision: 'maybe' });
    expect(bad.status).toBe(400);
  });

  it('finding 不属于该会话 → 404', async () => {
    const s1 = await insertSession({ status: 'completed' });
    const s2 = await insertSession({ status: 'completed' });
    const fid = await insertFinding(s1);
    const r = await request(app).post(`/api/explorations/${s2}/findings/${fid}/review`).send({ decision: 'confirmed' });
    expect(r.status).toBe(404);
  });
});

describe('升格为用例', () => {
  it('未确认的 finding → 409', async () => {
    const sessionId = await insertSession({ status: 'completed' });
    const fid = await insertFinding(sessionId, { status: 'pending' });
    const r = await request(app).post(`/api/explorations/${sessionId}/findings/${fid}/promote`).send({ groupId });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('not_confirmed');
  });

  it('已确认 → 建用例（步骤取动作留痕，带机械 DSL）+ 回写 promoted', async () => {
    const sessionId = await insertSession({ status: 'completed' });
    const fid = await insertFinding(sessionId, {
      status: 'confirmed',
      severity: 'P1',
      title: '删除无二次确认',
      reproSteps: [{ action: '点击删除' }, { action: '确认删除' }],
    });
    const r = await request(app).post(`/api/explorations/${sessionId}/findings/${fid}/promote`).send({ groupId });
    expect(r.status).toBe(201);
    const caseId = r.body.caseId;
    expect(caseId).toBeTruthy();
    const c = (await pool.query(`SELECT title, priority FROM test_cases WHERE id=$1`, [caseId])).rows[0]!;
    expect(c.title).toBe('删除无二次确认');
    expect(c.priority).toBe('P1');
    const steps = (await pool.query(`SELECT instruction, compiled FROM test_steps WHERE case_id=$1 ORDER BY "order"`, [caseId])).rows;
    // 留痕优先（模型自述可能脑补）→ 步骤取平台记录的 click .del，并带机械 DSL。
    expect(steps.map((s: { instruction: string }) => s.instruction)).toEqual(['点击 .del']);
    expect(steps[0]!.compiled).toEqual([{ kind: 'click', locator: [{ strategy: 'css', value: '.del' }] }]);
    const f = (await pool.query(`SELECT status, promoted_case_id FROM exploration_findings WHERE id=$1`, [fid])).rows[0]!;
    expect(f.status).toBe('promoted');
    expect(f.promoted_case_id).toBe(caseId);
  });

  it('留痕非空 → 步骤取留痕（reproSteps 不参与）', async () => {
    const sessionId = await insertSession({ status: 'completed' });
    const fid = await insertFinding(sessionId, {
      status: 'confirmed',
      reproSteps: [],
      actionsTrail: [{ type: 'click', target: '.del', ok: true }, { type: 'navigate', target: 'https://x/list', ok: true }],
    });
    const r = await request(app).post(`/api/explorations/${sessionId}/findings/${fid}/promote`).send({ groupId });
    expect(r.status).toBe(201);
    const steps = (await pool.query(`SELECT instruction, compiled FROM test_steps WHERE case_id=$1 ORDER BY "order"`, [r.body.caseId])).rows;
    expect(steps.map((s: { instruction: string }) => s.instruction)).toEqual(['点击 .del', '访问 https://x/list']);
    expect(steps[0]!.compiled).toEqual([{ kind: 'click', locator: [{ strategy: 'css', value: '.del' }] }]);
    expect(steps[1]!.compiled).toEqual([{ kind: 'navigate', url: 'https://x/list' }]);
  });

  it('留痕空 → 回落模型 reproSteps（自然语言，compiled=null）', async () => {
    const sessionId = await insertSession({ status: 'completed' });
    const fid = await insertFinding(sessionId, {
      status: 'confirmed',
      reproSteps: [{ action: '点击删除' }, { action: '确认删除' }],
      actionsTrail: [],
    });
    const r = await request(app).post(`/api/explorations/${sessionId}/findings/${fid}/promote`).send({ groupId });
    expect(r.status).toBe(201);
    const steps = (await pool.query(`SELECT instruction, compiled FROM test_steps WHERE case_id=$1 ORDER BY "order"`, [r.body.caseId])).rows;
    expect(steps.map((s: { instruction: string }) => s.instruction)).toEqual(['点击删除', '确认删除']);
    expect(steps.every((s: { compiled: unknown }) => s.compiled === null)).toBe(true);
  });

  it('两者都空 → 400 no_repro_steps', async () => {
    const sessionId = await insertSession({ status: 'completed' });
    const fid = await insertFinding(sessionId, { status: 'confirmed', reproSteps: [], actionsTrail: [] });
    const r = await request(app).post(`/api/explorations/${sessionId}/findings/${fid}/promote`).send({ groupId });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('no_repro_steps');
  });

  it('分组属于别的项目 → 400 group_project_mismatch', async () => {
    const sessionId = await insertSession({ status: 'completed' });
    const fid = await insertFinding(sessionId, { status: 'confirmed' });
    const r = await request(app).post(`/api/explorations/${sessionId}/findings/${fid}/promote`).send({ groupId: otherGroupId });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('group_project_mismatch');
  });

  it('已升格再升 → 409 already_promoted', async () => {
    const sessionId = await insertSession({ status: 'completed' });
    const fid = await insertFinding(sessionId, { status: 'confirmed' });
    const first = await request(app).post(`/api/explorations/${sessionId}/findings/${fid}/promote`).send({ groupId });
    expect(first.status).toBe(201);
    const second = await request(app).post(`/api/explorations/${sessionId}/findings/${fid}/promote`).send({ groupId });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('already_promoted');
  });
});
