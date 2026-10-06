import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { testCases, testSteps, groups, scenarios, caseTags } from '../db/schema.js';
import { eq, asc, inArray } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';
import { assertCaseVisible, assertProjectVisible, assertVersionVisible, visibleProjectIds } from '../services/projectAccess.js';
import { createCase, deleteCase, getCaseDetail, groupProjectId, tagsForCases, updateCase } from '../services/cases.service.js';

export const casesRoute = Router();

const CaseBodyBase = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).default('P1'),
  requirementId: z.string().uuid().optional(),
  groupId: z.string().uuid(),
  versionId: z.string().uuid().optional(),
  url: z.string().optional(),
  windowStrategy: z.enum(['maximize', 'current', 'custom']).default('maximize'),
  windowWidth: z.number().int().min(200).max(10000).optional(),
  windowHeight: z.number().int().min(200).max(10000).optional(),
  incognito: z.boolean().default(false),
  tagIds: z.array(z.string().uuid()).optional(),
  /** Track 1：用例级预期描述（自然语言）。回放结束后由 vision LLM 拿最终截图判定。 */
  expectedOutcome: z.string().max(4000).nullable().optional(),
});

const CaseStatusEnum = z.enum(['draft', 'review', 'ready', 'deprecated']);

function checkWindowStrategy(
  val: { windowStrategy?: string; windowWidth?: number; windowHeight?: number },
  ctx: z.RefinementCtx,
): void {
  if (val.windowStrategy === 'custom' && (!val.windowWidth || !val.windowHeight)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['windowWidth'],
      message: 'windowWidth and windowHeight are required when windowStrategy is custom',
    });
  }
}

const CreateBody = CaseBodyBase.superRefine(checkWindowStrategy);
const PatchBody = CaseBodyBase.partial()
  .extend({
    scenarioId: z.string().uuid().nullable().optional(),
    status: CaseStatusEnum.optional(),
    // 用例级 init URL 允许置空（清除覆盖，回到分组/项目继承链）
    url: z.string().url().nullable().optional(),
    // 用例默认 environment id；null 表示清空，undefined 表示不动
    defaultEnvId: z.string().uuid().nullable().optional(),
  })
  .superRefine(checkWindowStrategy);

casesRoute.get('/', async (req, res) => {
  const { priority, groupId, projectId, scenarioId } = req.query as Record<string, string | undefined>;
  let rows;
  if (projectId) {
    await assertProjectVisible(projectId, req.user!);
    const gs = await db.select().from(groups).where(eq(groups.projectId, projectId));
    const gids = gs.map((g) => g.id);
    rows = gids.length
      ? await db.select().from(testCases).where(inArray(testCases.groupId, gids))
      : [];
  } else if (groupId) {
    const g = await db.select().from(groups).where(eq(groups.id, groupId)).limit(1);
    if (!g[0]) throw new HttpError(404, 'not_found', 'group not found');
    await assertProjectVisible(g[0].projectId, req.user!);
    rows = await db.select().from(testCases).where(eq(testCases.groupId, groupId));
  } else {
    // 无参分支：按可见项目过滤
    const visiblePids = await visibleProjectIds(req.user!);
    const gs = visiblePids.length
      ? await db.select().from(groups).where(inArray(groups.projectId, visiblePids))
      : [];
    const gids = gs.map((g) => g.id);
    rows = gids.length
      ? await db.select().from(testCases).where(inArray(testCases.groupId, gids))
      : [];
  }
  if (priority) rows = rows.filter((r) => r.priority === priority);
  // scenarioId 过滤：'none' 命中 scenarioId IS NULL；UUID 命中具体场景
  if (scenarioId) {
    rows = scenarioId === 'none'
      ? rows.filter((r) => r.scenarioId == null)
      : rows.filter((r) => r.scenarioId === scenarioId);
  }
  // 把 scenario title 一起带回去，避免前端为每个 case 再发一次 detail 请求
  const sids = [...new Set(rows.map((r) => r.scenarioId).filter((v): v is string => !!v))];
  const sById = new Map<string, { id: string; title: string }>();
  if (sids.length > 0) {
    const scRows = await db
      .select({ id: scenarios.id, title: scenarios.title })
      .from(scenarios)
      .where(inArray(scenarios.id, sids));
    for (const s of scRows) sById.set(s.id, s);
  }
  // 同手法：批量回填 tags（避免 N+1）
  const caseIds = rows.map((r) => r.id);
  const tagsByCase = await tagsForCases(caseIds);
  res.json(
    rows.map((r) => ({
      ...r,
      scenarioTitle: r.scenarioId ? (sById.get(r.scenarioId)?.title ?? null) : null,
      tags: tagsByCase.get(r.id) ?? [],
    })),
  );
});

casesRoute.post('/', async (req, res) => {
  const body = CreateBody.parse(req.body);
  const pid = await groupProjectId(body.groupId);
  if (!pid) throw new HttpError(404, 'not_found', 'group not found');
  await assertProjectVisible(pid, req.user!);
  // versionId 必填：前端所有入口都显式带版本，无默认版本回退；传了则必须同 project
  const versionId = body.versionId;
  if (!versionId) throw new HttpError(400, 'version_required', 'versionId is required');
  const { projectId: vp } = await assertVersionVisible(versionId, req.user!);
  if (vp !== pid) throw new HttpError(400, 'version_mismatch', 'version does not belong to this project');
  res.json(await createCase({ ...body, versionId }));
});

casesRoute.get('/:id', async (req, res) => {
  await assertCaseVisible(req.params.id!, req.user!);
  const detail = await getCaseDetail(req.params.id!);
  if (!detail) throw new HttpError(404, 'not_found', 'case not found');
  res.json(detail);
});

casesRoute.patch('/:id', async (req, res) => {
  const body = PatchBody.parse(req.body);
  await assertCaseVisible(req.params.id!, req.user!);
  if (body.groupId !== undefined) {
    // 移动目标分组也必须可见
    const pid = await groupProjectId(body.groupId);
    if (!pid) throw new HttpError(404, 'not_found', 'group not found');
    await assertProjectVisible(pid, req.user!);
  }
  if (body.defaultEnvId !== undefined && body.defaultEnvId !== null) {
    const { assertEnvironmentVisible } = await import('../services/projectAccess.js');
    await assertEnvironmentVisible(body.defaultEnvId, req.user!);
  }
  // scenario 匹配 / env 归属 / tag 组织校验由 service 兜底
  res.json(await updateCase(req.params.id!, body));
});

async function nextCopyTitle(base: string, existing: string[]): Promise<string> {
  const taken = new Set(existing);
  const first = `${base} 副本`;
  if (!taken.has(first)) return first;
  let n = 1;
  while (taken.has(`${base} 副本${n}`)) n++;
  return `${base} 副本${n}`;
}

async function copyOneCase(caseId: string, targetGroupId: string, targetVersionId: string | null, user: NonNullable<Express.Request['user']>): Promise<unknown> {
  const src = (await db.select().from(testCases).where(eq(testCases.id, caseId)))[0];
  if (!src) throw new HttpError(404, 'not_found', 'case not found');
  // 源 case 与目标分组所在项目都必须可见
  await assertCaseVisible(caseId, user);
  const targetGroup = (await db.select().from(groups).where(eq(groups.id, targetGroupId)))[0];
  if (targetGroup) await assertProjectVisible(targetGroup.projectId, user);
  // versionId 未传 → 同版本复制；否则校验属于 targetGroup.projectId
  let versionId = src.versionId;
  if (targetVersionId) {
    const { projectId: vp } = await assertVersionVisible(targetVersionId, user);
    if (targetGroup && vp !== targetGroup.projectId) throw new HttpError(400, 'version_mismatch', 'version does not belong to target project');
    versionId = targetVersionId;
  }
  const siblings = await db.select({ title: testCases.title }).from(testCases).where(eq(testCases.groupId, targetGroupId));
  const title = await nextCopyTitle(src.title, siblings.map((s) => s.title));
  const steps = await db
    .select()
    .from(testSteps)
    .where(eq(testSteps.caseId, caseId))
    .orderBy(asc(testSteps.order));
  const inserted = await db
    .insert(testCases)
    .values({
      title,
      description: src.description,
      priority: src.priority,
      groupId: targetGroupId,
      versionId,
      url: src.url,
    })
    .returning();
  const newCase = inserted[0]!;
  if (steps.length > 0) {
    await db.insert(testSteps).values(
      steps.map((s) => ({
        caseId: newCase.id,
        order: s.order,
        source: s.source,
        instruction: s.instruction,
        compiled: s.compiled,
        assertion: s.assertion,
      })),
    );
  }
  // 复制 src 的标签关联（id 不变，跨项目复制时已被 assertProjectVisible 拦截）
  const srcTagRows = await db.select({ tagId: caseTags.tagId }).from(caseTags).where(eq(caseTags.caseId, caseId));
  if (srcTagRows.length > 0) {
    await db.insert(caseTags).values(srcTagRows.map((r) => ({ caseId: newCase.id, tagId: r.tagId })));
  }
  return newCase;
}

casesRoute.post('/:id/copy', async (req, res) => {
  const body = z.object({ targetGroupId: z.string().uuid(), targetVersionId: z.string().uuid().optional() }).parse(req.body);
  const g = await db.select().from(groups).where(eq(groups.id, body.targetGroupId));
  if (g.length === 0) throw new HttpError(404, 'not_found', 'group not found');
  await assertProjectVisible(g[0]!.projectId, req.user!);
  res.json(await copyOneCase(req.params.id!, body.targetGroupId, body.targetVersionId ?? null, req.user!));
});

casesRoute.post('/copy', async (req, res) => {
  const body = z.object({
    caseIds: z.array(z.string().uuid()).min(1),
    targetGroupId: z.string().uuid(),
    targetVersionId: z.string().uuid().optional(),
  }).parse(req.body);
  const g = await db.select().from(groups).where(eq(groups.id, body.targetGroupId));
  if (g.length === 0) throw new HttpError(404, 'not_found', 'group not found');
  await assertProjectVisible(g[0]!.projectId, req.user!);
  for (const id of body.caseIds) {
    await copyOneCase(id, body.targetGroupId, body.targetVersionId ?? null, req.user!);
  }
  res.json({ count: body.caseIds.length });
});

casesRoute.delete('/:id', async (req, res) => {
  await assertCaseVisible(req.params.id!, req.user!);
  await deleteCase(req.params.id!);
  res.json({ ok: true });
});

casesRoute.post('/batch-delete', async (req, res) => {
  const body = z.object({ caseIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
  // 与单删一致：先按可见性逐个校验，违规直接 404
  for (const id of body.caseIds) {
    await assertCaseVisible(id, req.user!);
  }
  const deleted = await db
    .delete(testCases)
    .where(inArray(testCases.id, body.caseIds))
    .returning({ id: testCases.id });
  res.json({ count: deleted.length });
});

casesRoute.post('/batch-status', async (req, res) => {
  const body = z
    .object({
      caseIds: z.array(z.string().uuid()).min(1),
      status: CaseStatusEnum,
    })
    .parse(req.body);
  // 与 batch-delete 一致：先按可见性逐个校验，违规直接 404
  for (const id of body.caseIds) {
    await assertCaseVisible(id, req.user!);
  }
  const updated = await db
    .update(testCases)
    .set({ status: body.status, updatedAt: new Date() })
    .where(inArray(testCases.id, body.caseIds))
    .returning({ id: testCases.id });
  res.json({ count: updated.length });
});
