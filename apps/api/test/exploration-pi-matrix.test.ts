/**
 * P4 回归：C2 章程分解 + C3 人格矩阵 + S2 跨会话交集。
 *
 * 覆盖：
 *  ① 章程分解：模型输出形状容错（goals/plan/裸数组/脏输出）+ 去重封顶 + 软失败
 *     （LLM 挂了 = 无子目标，不掀翻会话——与代码范围解析同款语义）；
 *  ② 矩阵建组：一组人格 → N 个会话共用 matrix_id，matrix_role=persona，重复人格去重；
 *  ③ 矩阵视图 / 取消：矩阵内会话与 findings 可见；取消只影响未终态会话；
 *  ④ S2 交集：同源近义标题 → cross_session_count=2；跨 origin 不算共同发现；
 *     只标注不改 findings.status（人工审阅才是权威）。
 *
 * 真实实现会起 chromium + 调 LLM，本测试全部打桩，只验平台自己的语义。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';
import type { AuthUser } from '../src/services/auth.service.js';
import type { LLMClient } from '../src/agent/llm-client.js';

// runner 打桩：真实实现会起 chromium + 调 LLM，路由测试只验契约与状态机。
const { runMock } = vi.hoisted(() => ({
  runMock: vi.fn(async (_input: { sessionId: string }) => undefined),
}));
vi.mock('../src/execute/exploration.js', () => ({
  runExplorationSession: runMock,
  removeExplorationScreenshots: vi.fn(async (_sessionId: string) => undefined),
}));

const CHARTER = '探索用户管理页面的增删改查，报告所有异常行为与校验缺失。';

let pool: Pool;
let app: import('express').Express;
let projectId: string;
let versionId: string;
let userId: string;
let username: string;
let orgId: string;
let orgPath: string;
let currentUser: AuthUser;
let managerUserOf: typeof import('./helpers/auth.js').managerUserOf;

/** 动态导入的模块（env 设好后才加载——db/client 导入即快照 DATABASE_URL）。 */
let parseGoals: typeof import('../src/pi/exploration/decompose.js').parseGoals;
let decomposeCharter: typeof import('../src/pi/exploration/decompose.js').decomposeCharter;
let recomputeMatrixIntersection: typeof import('../src/pi/exploration/matrix.js').recomputeMatrixIntersection;
let finishSession: typeof import('../src/execute/explorationShared.js').finishSession;

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
  const seed = await seedOrg(pool);
  userId = seed.userId;
  username = seed.username;
  orgId = seed.orgId;
  orgPath = seed.orgPath;
  const seeded = await seedProject(pool);
  projectId = seeded.projectId;
  versionId = seeded.versionId;
  currentUser = managerUserOf(userId, username, orgId, orgPath);
  app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    req.user = currentUser;
    next();
  });
  app.use('/api/explorations', explorationsRoute);
  app.use(errorHandler);

  const decompose = await import('../src/pi/exploration/decompose.js');
  parseGoals = decompose.parseGoals;
  decomposeCharter = decompose.decomposeCharter;
  const matrix = await import('../src/pi/exploration/matrix.js');
  recomputeMatrixIntersection = matrix.recomputeMatrixIntersection;
  const shared = await import('../src/execute/explorationShared.js');
  finishSession = shared.finishSession;
}, 60000);

afterAll(async () => {
  const { pool: p } = await import('../src/db/client.js');
  await p.end().catch(() => undefined);
  await pool.end();
});

/** 建一条带矩阵分组的会话（落库直写，绕开 runner）。 */
async function insertMatrixSession(opts: {
  matrixId: string;
  role: string;
  startUrl?: string | null;
  status?: string;
}): Promise<string> {
  const r = await pool.query(
    `INSERT INTO exploration_sessions(project_id, version_id, title, charter, persona, status, created_by_user_id, matrix_id, matrix_label, matrix_role, start_url)
     VALUES ($1,$2,'矩阵会话',$3,$4,$5,$6,$7,'矩阵',$4,$8) RETURNING id`,
    [
      projectId,
      versionId,
      CHARTER,
      opts.role,
      opts.status ?? 'completed',
      userId,
      opts.matrixId,
      opts.startUrl ?? 'http://sut.local/app/users',
    ],
  );
  return r.rows[0]!.id as string;
}

/** 建一条 finding（标题用于近义判定）。 */
async function insertFinding(sessionId: string, title: string, order = 1): Promise<string> {
  const r = await pool.query(
    `INSERT INTO exploration_findings(session_id, "order", title, description)
     VALUES ($1,$2,$3,'描述') RETURNING id`,
    [sessionId, order, title],
  );
  return r.rows[0]!.id as string;
}

describe('P4 · C2 章程分解', () => {
  it('输出形状容错：goals/plan/裸数组都认，脏输出兜底为空', () => {
    expect(parseGoals({ goals: [{ text: '打开新增对话框' }, { text: '空值提交看是否被拒' }] })).toEqual([
      { id: 'g1', text: '打开新增对话框' },
      { id: 'g2', text: '空值提交看是否被拒' },
    ]);
    expect(parseGoals(['裸字符串子目标'])).toEqual([{ id: 'g1', text: '裸字符串子目标' }]);
    expect(parseGoals({ plan: [{ goal: '用 plan 键承载' }] })).toEqual([{ id: 'g1', text: '用 plan 键承载' }]);
    // 脏输出 → 无子目标（不抛错）。
    expect(parseGoals(null)).toEqual([]);
    expect(parseGoals({ goals: '不是数组' })).toEqual([]);
    expect(parseGoals({ goals: [{ text: '   ' }] })).toEqual([]);
  });

  it('去重 + 封顶 12 条（超出的丢弃，不无限膨胀）', () => {
    expect(parseGoals({ goals: [{ text: '重复' }, { text: '重复' }] })).toHaveLength(1);
    const many = Array.from({ length: 15 }, (_, i) => ({ text: `子目标${i}` }));
    expect(parseGoals({ goals: many })).toHaveLength(12);
  });

  it('分解成功 → 子目标进账本；LLM 挂了 → 空子目标（软失败，不掀翻会话）', async () => {
    const ok: LLMClient = {
      provider: 'openai',
      complete: async () => ({
        kind: 'json',
        value: { goals: [{ text: '打开新增对话框' }, { text: '空值提交' }] },
        provider: 'openai',
        vision: false,
      }),
    };
    const goals = await decomposeCharter({ charter: CHARTER, persona: 'qa' }, { llm: ok });
    expect(goals.map((g) => g.text)).toEqual(['打开新增对话框', '空值提交']);

    const boom: LLMClient = {
      provider: 'openai',
      complete: async () => {
        throw new Error('网关 500');
      },
    };
    await expect(decomposeCharter({ charter: CHARTER }, { llm: boom })).resolves.toEqual([]);
  });
});

describe('P4 · C3 人格矩阵', () => {
  it('建组：一组人格 → N 个会话共用 matrix_id，matrix_role=persona，重复人格去重', async () => {
    runMock.mockClear();
    const r = await request(app)
      .post('/api/explorations/matrix')
      .send({ versionId, charter: CHARTER, personas: ['qa', 'novice', 'qa'], label: '两人格矩阵' });
    expect(r.status).toBe(201);
    expect(r.body.matrixId).toBeTruthy();
    expect(r.body.sessions).toHaveLength(2);

    const rows = await pool.query(
      `SELECT matrix_id, matrix_label, matrix_role, persona FROM exploration_sessions WHERE matrix_id=$1`,
      [r.body.matrixId],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((x) => x.matrix_id === r.body.matrixId)).toBe(true);
    expect(rows.rows.every((x) => x.matrix_label === '两人格矩阵')).toBe(true);
    expect(rows.rows.map((x) => x.matrix_role).sort()).toEqual(['novice', 'qa']);
    // 每个会话各派发一次（矩阵 = N 次独立探索）。
    expect(runMock).toHaveBeenCalledTimes(2);
  });

  it('矩阵视图：返回矩阵内会话 + findings；未知 matrix → 404', async () => {
    const created = await request(app)
      .post('/api/explorations/matrix')
      .send({ versionId, charter: CHARTER, personas: ['qa', 'power'] });
    expect(created.status).toBe(201);
    const matrixId = created.body.matrixId as string;

    const view = await request(app).get(`/api/explorations/matrix/${matrixId}`);
    expect(view.status).toBe(200);
    expect(view.body.matrixId).toBe(matrixId);
    expect(view.body.sessions).toHaveLength(2);
    expect(Array.isArray(view.body.findings)).toBe(true);

    const missing = await request(app).get('/api/explorations/matrix/00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBe(404);
  });

  it('取消矩阵：只影响未终态会话，已终态的不动', async () => {
    const created = await request(app)
      .post('/api/explorations/matrix')
      .send({ versionId, charter: CHARTER, personas: ['qa', 'novice'] });
    const matrixId = created.body.matrixId as string;
    const ids = (created.body.sessions as Array<{ id: string }>).map((s) => s.id);
    // 一个会话置终态（模拟已跑完），另一个保持 pending。
    await pool.query(`UPDATE exploration_sessions SET status='completed' WHERE id=$1`, [ids[0]]);

    const r = await request(app).post(`/api/explorations/matrix/${matrixId}/cancel`);
    expect(r.status).toBe(200);
    expect(r.body.cancelled).toBe(1);

    const rows = await pool.query(`SELECT id, cancel_requested, status FROM exploration_sessions WHERE matrix_id=$1`, [matrixId]);
    const byId = new Map(rows.rows.map((x) => [x.id as string, x]));
    expect(byId.get(ids[0]!)!.cancel_requested).toBe(false);
    expect(byId.get(ids[1]!)!.cancel_requested).toBe(true);
  });

  it('建组参数校验：personas 空 → 400；未知 persona → 400；只给一个窗口尺寸 → 400', async () => {
    const empty = await request(app).post('/api/explorations/matrix').send({ versionId, charter: CHARTER, personas: [] });
    expect(empty.status).toBe(400);
    const bad = await request(app)
      .post('/api/explorations/matrix')
      .send({ versionId, charter: CHARTER, personas: ['nope'] });
    expect(bad.status).toBe(400);
    const halfWindow = await request(app)
      .post('/api/explorations/matrix')
      .send({ versionId, charter: CHARTER, personas: ['qa'], windowWidth: 1600 });
    expect(halfWindow.status).toBe(400);
    expect(halfWindow.body.error).toBe('window_required');
  });
});

describe('P4 · S2 跨会话交集', () => {
  it('同源近义标题 → cross_session_count=2；跨 origin 不算共同发现', async () => {
    const matrixId = '11111111-1111-4111-8111-111111111111';
    const s1 = await insertMatrixSession({ matrixId, role: 'qa', startUrl: 'http://sut.local/app/users' });
    const s2 = await insertMatrixSession({ matrixId, role: 'novice', startUrl: 'http://sut.local/app/users' });
    const s3 = await insertMatrixSession({ matrixId, role: 'power', startUrl: 'http://other.local/app/users' });

    // s1/s2 标题近义（同一缺陷换措辞）；s3 是另一个站点 → 不参与同源比对。
    await insertFinding(s1, '保存按钮点击后列表未刷新');
    await insertFinding(s2, '保存按钮点击后列表没有刷新');
    await insertFinding(s3, '保存按钮点击后列表未刷新');

    await recomputeMatrixIntersection(matrixId);

    const rows = await pool.query(
      `SELECT f.session_id, f.cross_session_count, f.status
       FROM exploration_findings f WHERE f.session_id = ANY($1::uuid[]) ORDER BY f.session_id`,
      [[s1, s2, s3]],
    );
    const bySession = new Map(rows.rows.map((x) => [x.session_id as string, x]));
    expect(Number(bySession.get(s1)!.cross_session_count)).toBe(2);
    expect(Number(bySession.get(s2)!.cross_session_count)).toBe(2);
    // 跨 origin 的同名单缺陷不算「多视角共同发现」。
    expect(Number(bySession.get(s3)!.cross_session_count)).toBe(1);
    // 只标注：人工审阅状态不被交集计算改动。
    for (const row of rows.rows) expect(row.status).toBe('pending');
  });

  it('会话收尾（finishSession）→ 触发矩阵交集重算', async () => {
    const matrixId = '22222222-2222-4222-8222-222222222222';
    const s1 = await insertMatrixSession({ matrixId, role: 'qa', status: 'running' });
    const s2 = await insertMatrixSession({ matrixId, role: 'power', status: 'running' });
    await insertFinding(s1, '分页参数越界时返回全量数据');
    await insertFinding(s2, '分页参数越界时返回了全量数据');

    await finishSession(s1, { status: 'completed', turnsUsed: 3, usage: {} });

    // 交集重算是 fire-and-forget → 轮询等它落库。
    const deadline = Date.now() + 5000;
    let counts: number[] = [];
    while (Date.now() < deadline) {
      const rows = await pool.query(
        `SELECT cross_session_count FROM exploration_findings WHERE session_id = ANY($1::uuid[]) ORDER BY session_id`,
        [[s1, s2]],
      );
      counts = rows.rows.map((x) => Number(x.cross_session_count));
      if (counts.length === 2 && counts.every((c) => c === 2)) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    expect(counts).toEqual([2, 2]);
  });

  it('单会话矩阵 → 无跨会话（计数保持 1）', async () => {
    const matrixId = '33333333-3333-4333-8333-333333333333';
    const s1 = await insertMatrixSession({ matrixId, role: 'qa' });
    await insertFinding(s1, '唯一会话的缺陷');
    await recomputeMatrixIntersection(matrixId);
    const rows = await pool.query(`SELECT cross_session_count FROM exploration_findings WHERE session_id=$1`, [s1]);
    expect(Number(rows.rows[0]!.cross_session_count)).toBe(1);
  });
});
