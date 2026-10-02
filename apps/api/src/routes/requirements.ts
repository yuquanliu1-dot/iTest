import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { db } from '../db/client.js';
import { requirements, groups, aiThreads, aiWorkspaceState, scenarios, testCases, testSteps } from '../db/schema.js';
import { eq, asc, inArray } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';
import { assertProjectVisible, visibleProjectIds } from '../services/projectAccess.js';
import { compileAiStepsInPlace } from '../agent/aiStepCompile.js';
import { splitAiStepsInPlace } from '../agent/aiStepSplit.js';
import { loadDoc, removeSaved, type StagedCase } from '../pi/workspace.js';

export const requirementsRoute = Router({ mergeParams: true });

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  projectId: z.string().uuid().optional(),
});

/** 双挂载：/projects/:projectId/requirements 与 /requirements。可见性从项目维度判定。 */
requirementsRoute.get('/', async (req, res) => {
  const { projectId } = req.params as { projectId?: string };
  let rows;
  if (projectId) {
    await assertProjectVisible(projectId, req.user!);
    rows = await db.select().from(requirements).where(eq(requirements.projectId, projectId)).orderBy(asc(requirements.createdAt));
  } else {
    // 直挂载：按可见项目过滤
    const visiblePids = await visibleProjectIds(req.user!);
    rows = visiblePids.length
      ? await db.select().from(requirements).where(inArray(requirements.projectId, visiblePids)).orderBy(asc(requirements.createdAt))
      : [];
  }
  res.json(rows);
});

requirementsRoute.post('/', async (req, res) => {
  const paramsProjectId = (req.params as { projectId?: string }).projectId;
  const body = CreateBody.parse(req.body);
  const projectId = paramsProjectId ?? body.projectId;
  if (!projectId) throw new HttpError(400, 'bad_request', 'projectId is required');
  await assertProjectVisible(projectId, req.user!);
  const rows = await db
    .insert(requirements)
    .values({ ...body, projectId })
    .returning();
  res.json(rows[0]);
});

requirementsRoute.get('/:id', async (req, res) => {
  const rows = await db.select().from(requirements).where(eq(requirements.id, req.params.id));
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'requirement not found');
  // 经所属项目判定可见性（不依赖挂载参数，两种挂载统一）
  await assertProjectVisible(rows[0]!.projectId, req.user!);
  res.json(rows[0]);
});

// ─────────────────────────────────────────────────────────────────────────────
// AI 工作台：aux 端点
// ─────────────────────────────────────────────────────────────────────────────

requirementsRoute.post('/:id/ai-thread', async (req, res) => {
  const rows = await db.select().from(requirements).where(eq(requirements.id, req.params.id)).limit(1);
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'requirement not found');
  await assertProjectVisible(rows[0]!.projectId, req.user!);
  // 上限为 1：前端 useEffect 可能在初次 200 后再重发（避免 React 18 StrictMode 双触发 + 重连导致 409）。
  // 用 INSERT ... ON CONFLICT DO NOTHING + RETURNING，再 SELECT 兜底幂等。
  const threadId = randomUUID();
  const inserted = await db.insert(aiThreads)
    .values({ id: threadId, requirementId: req.params.id, piThreadId: '' })
    .onConflictDoNothing({ target: aiThreads.requirementId })
    .returning({ id: aiThreads.id });
  if (!inserted[0]) {
    const existing = await db.select({ id: aiThreads.id }).from(aiThreads).where(eq(aiThreads.requirementId, req.params.id)).limit(1);
    res.json({ threadId: existing[0]!.id });
    return;
  }
  await db.insert(aiWorkspaceState).values({ requirementId: req.params.id, doc: { plan: null, scenarios: [], looseCases: [] } }).onConflictDoNothing();
  res.json({ threadId });
});

requirementsRoute.get('/:id/ai-workspace', async (req, res) => {
  const rows = await db.select().from(requirements).where(eq(requirements.id, req.params.id)).limit(1);
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'requirement not found');
  await assertProjectVisible(rows[0]!.projectId, req.user!);
  res.json(await loadDoc(req.params.id));
});

const SaveBody = z.object({
  groupId: z.string().uuid(),
  scenarioIds: z.array(z.string()).default([]),
  caseIds: z.array(z.string()).default([]),
});

/** 把「打开 X 页」「访问 X」「打开登录页」等指令翻译成默认 URL。供 compileAiStep 当 ctx.url 兜底。 */
function inferPageUrl(name: string, instruction: string, fallback?: string): string | undefined {
  const text = `${name} ${instruction}`.toLowerCase();
  const dict: Record<string, string> = {
    '登录': '/login',
    'login': '/login',
    '注册': '/signup',
    '工作台': '/',
    '首页': '/',
    '设置': '/settings',
    '需求': '/requirements',
    '用例': '/cases',
    '计划': '/plans',
  };
  for (const [k, p] of Object.entries(dict)) {
    if (text.includes(k)) return fallback ? `${fallback.replace(/\/$/, '')}${p}` : `http://localhost:5173${p}`;
  }
  return undefined;
}

requirementsRoute.post('/:id/ai-workspace/save', async (req, res) => {
  const body = SaveBody.parse(req.body);
  const rows = await db.select().from(requirements).where(eq(requirements.id, req.params.id)).limit(1);
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'requirement not found');
  await assertProjectVisible(rows[0]!.projectId, req.user!);
  const g = (await db.select().from(groups).where(eq(groups.id, body.groupId)).limit(1))[0];
  if (!g || g.projectId !== rows[0]!.projectId) throw new HttpError(404, 'not_found', 'group not found');

  const doc = await loadDoc(req.params.id);
  const idSet = new Set(body.caseIds);
  const scenarioIdSet = new Set(body.scenarioIds);

  // 选中的用例：勾选场景下的全部用例 + 显式勾选的 caseIds（可命中场景下用例=部分勾选，也可命中散用例）。合并去重。
  // 注意：显式 caseIds 命中场景用例时只带那一条，不会带上整个场景（否则勾选任一散用例会带上所有选中场景的全部用例）。
  const selectedCaseById = new Map<string, StagedCase>();
  for (const s of doc.scenarios.filter((x) => scenarioIdSet.has(x.id))) {
    for (const c of s.cases) selectedCaseById.set(c.id, c);
  }
  for (const s of doc.scenarios) {
    for (const c of s.cases) if (idSet.has(c.id)) selectedCaseById.set(c.id, c);
  }
  for (const c of doc.looseCases) if (idSet.has(c.id)) selectedCaseById.set(c.id, c);
  const selectedCaseIds = [...selectedCaseById.keys()];

  // 场景行：显式勾选的场景 + 任何被显式勾选用例所属的场景（保证部分勾选的用例也挂到场景行）；
  // 勾选但无 case 的场景也会保留（仅落场景行）。
  const effectiveScenarioIds = new Set(scenarioIdSet);
  for (const s of doc.scenarios) {
    if (s.cases.some((c) => idSet.has(c.id))) effectiveScenarioIds.add(s.id);
  }
  const selectedScenarios = doc.scenarios.filter((s) => effectiveScenarioIds.has(s.id));

  // 找出 (requirementId, title) 已存在的场景，幂等复用
  const existingSc = await db.select({ id: scenarios.id, title: scenarios.title }).from(scenarios).where(eq(scenarios.requirementId, req.params.id));
  const scenarioByTitle = new Map(existingSc.map((r) => [r.title, r.id] as const));

  // 阶段 1（事务外）：构建步骤行 + 拆条 + LLM 编译。编译是慢速网络 IO，不能占着数据库事务。
  const groupDefaultUrl = g.defaultUrl ?? null;
  const prepared: Array<{ c: StagedCase; scenarioTitle: string | null; stepRows: Array<{ source: 'agent'; name: string; action: object; assertion: object | null; sensitive: boolean }> }> = [];
  for (const c of selectedCaseById.values()) {
    // 找到 c 所属场景行（按引用相等匹配）
    const owner = selectedScenarios.find((s) => s.cases.some((x) => x.id === c.id));
    const stepRows: Array<{
      source: 'agent';
      name: string;
      action: object;
      assertion: object | null;
      delayMs?: number;
      tabRef?: string;
      componentKind?: string;
      sensitive: boolean;
      secretCiphertext?: string;
      secretIv?: string;
      secretTag?: string;
    }> = c.steps.map((s) => ({
      source: 'agent' as const,
      name: s.name,
      action: { kind: 'aiStep', instruction: s.action, compiled: null } as object,
      assertion: s.assertion ? ({ kind: 'assertText', text: s.assertion } as object) : null,
      sensitive: false,
    }));
    if (stepRows.length > 0) {
      // 把 AI case 的 steps[] 当作 aiStep 数组落地前先做编号拆分（多条 aiStep）
      // 与立即编译（fill 落定值、click locator 落 role/text），回放时不依赖 LLM。
      splitAiStepsInPlace(stepRows as unknown as Array<{ action: unknown }>);
      try {
        await compileAiStepsInPlace(
          stepRows.map((row) => ({ action: row.action, name: row.name })),
          undefined,
          (name) => inferPageUrl(name ?? '', '', groupDefaultUrl ?? undefined),
        );
      } catch {
        // 编译失败不阻塞保存；保留 aiStep 原样 + compiled:null，回放时按 aiStep 路径处理
      }
    }
    prepared.push({ c, scenarioTitle: owner?.title ?? null, stepRows });
  }

  let savedCases = 0;
  // 阶段 2（事务内）：纯写库
  await db.transaction(async (tx) => {
    for (const s of selectedScenarios) {
      if (!scenarioByTitle.has(s.title)) {
        const ins = await tx.insert(scenarios).values({ requirementId: req.params.id, title: s.title, description: s.description, order: 0 }).returning();
        scenarioByTitle.set(s.title, ins[0]!.id);
      }
    }
    for (const p of prepared) {
      const scenarioId = p.scenarioTitle ? scenarioByTitle.get(p.scenarioTitle) ?? null : null;
      const c = p.c;
      const tc = await tx.insert(testCases).values({
        requirementId: req.params.id,
        groupId: body.groupId,
        scenarioId,
        title: c.title,
        description: c.description,
        priority: c.priority,
      }).returning();
      if (p.stepRows.length > 0) {
        await tx.insert(testSteps).values(p.stepRows.map((row, i) => ({
          caseId: tc[0]!.id,
          order: i,
          source: row.source,
          name: row.name,
          action: row.action,
          assertion: row.assertion,
          sensitive: row.sensitive,
        })));
      }
      savedCases += 1;
    }
  });

  await removeSaved(req.params.id, selectedCaseIds);
  res.json({ savedCases });
});
