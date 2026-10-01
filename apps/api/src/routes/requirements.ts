import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { db } from '../db/client.js';
import { requirements, groups, aiThreads, aiWorkspaceState, scenarios, testCases, testSteps } from '../db/schema.js';
import { eq, asc, inArray } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';
import { assertProjectVisible, visibleProjectIds } from '../services/projectAccess.js';
import { loadDoc, removeSaved } from '../pi/workspace.js';

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
  const existing = await db.select({ id: aiThreads.id }).from(aiThreads).where(eq(aiThreads.requirementId, req.params.id)).limit(1);
  let threadId: string;
  if (existing[0]) {
    threadId = existing[0]!.id;
  } else {
    threadId = randomUUID();
    await db.insert(aiThreads).values({ id: threadId, requirementId: req.params.id, piThreadId: '' });
    await db.insert(aiWorkspaceState).values({ requirementId: req.params.id, doc: { plan: null, scenarios: [], looseCases: [] } }).onConflictDoNothing();
  }
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

  // 选中的用例：勾选场景下的全部用例 + 显式勾选的散用例（looseCases）。两种来源合并去重。
  // 注意：场景筛选只看 scenarioIdSet；不能用 looseCases 命中与否去反向包含场景（否则勾选任一散用例会带上所有选中场景的全部用例）。
  const selectedCases = doc.scenarios
    .filter((s) => scenarioIdSet.has(s.id))
    .flatMap((s) => s.cases)
    .concat(doc.looseCases.filter((c) => idSet.has(c.id)));
  const selectedCaseById = new Map(selectedCases.map((c) => [c.id, c]));
  const selectedCaseIds = [...selectedCaseById.keys()];
  // 勾选但无 case 的场景也会保留（仅落场景行）
  const selectedScenarios = doc.scenarios.filter((s) => scenarioIdSet.has(s.id));

  // 找出 (requirementId, title) 已存在的场景，幂等复用
  const existingSc = await db.select({ id: scenarios.id, title: scenarios.title }).from(scenarios).where(eq(scenarios.requirementId, req.params.id));
  const scenarioByTitle = new Map(existingSc.map((r) => [r.title, r.id] as const));

  let savedCases = 0;
  await db.transaction(async (tx) => {
    for (const s of selectedScenarios) {
      if (!scenarioByTitle.has(s.title)) {
        const ins = await tx.insert(scenarios).values({ requirementId: req.params.id, title: s.title, description: s.description, order: 0 }).returning();
        scenarioByTitle.set(s.title, ins[0]!.id);
      }
    }
    for (const c of selectedCaseById.values()) {
      // 找到 c 所属场景行（按引用相等匹配）
      const owner = selectedScenarios.find((s) => s.cases.some((x) => x.id === c.id));
      const scenarioId = owner ? scenarioByTitle.get(owner.title) ?? null : null;
      const tc = await tx.insert(testCases).values({
        requirementId: req.params.id,
        groupId: body.groupId,
        scenarioId,
        title: c.title,
        description: c.description,
        priority: c.priority,
      }).returning();
      if (c.steps.length > 0) {
        await tx.insert(testSteps).values(c.steps.map((s, i) => ({
          caseId: tc[0]!.id,
          order: i,
          source: 'agent' as const,
          name: s.name,
          action: { kind: 'aiStep', instruction: s.action, compiled: null } as object,
          assertion: s.assertion ? { kind: 'assertText', text: s.assertion } as object : null,
        })));
      }
      savedCases += 1;
    }
  });

  await removeSaved(req.params.id, selectedCaseIds);
  res.json({ savedCases });
});
