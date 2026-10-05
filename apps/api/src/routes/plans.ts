import { Router } from 'express';
import { z } from 'zod';
import { eq, and, asc, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  environmentObjects,
  executionPlans,
  planCases,
  planRuns,
  testCases,
  groups,
  projectVersions,
} from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { findIncognitoCaseIds, runPlanAsync } from '../execute/runPlan.js';
import { assertProjectVisible, assertVersionVisible, visibleProjectIds } from '../services/projectAccess.js';
import { createPlan, updatePlan, getPlanDetail, replacePlanCases, planProjectId, removePlanCases } from '../services/plans.service.js';
import { logger } from '../logger.js';

export const plansRoute = Router({ mergeParams: true });

const StrategyEnum = z.enum(['run_all', 'fail_fast']);

const LoginPrepareBody = z
  .object({
    enabled: z.boolean(),
    caseId: z.string().uuid().optional().nullable(),
    detectionUrl: z.string().url().optional().nullable(),
    successSelector: z.string().max(500).optional().nullable(),
    unauthorizedKeywords: z.array(z.string().max(80)).max(20).optional().nullable(),
  })
  .optional();

const CreateBody = z.object({
  name: z.string().min(1).max(200),
  environment: z.string().max(100).optional(),
  versionId: z.string().uuid().optional(),
  strategy: StrategyEnum.default('run_all'),
  loginPrepare: LoginPrepareBody,
});

const PatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  environment: z.string().max(100).optional(),
  environmentId: z.string().uuid().nullable().optional(),
  versionId: z.string().uuid().nullable().optional(),
  strategy: StrategyEnum.optional(),
  loginPrepare: LoginPrepareBody,
});

plansRoute.get('/', async (req, res) => {
  const { projectId } = req.params as { projectId?: string };
  let ps;
  if (projectId) {
    await assertProjectVisible(projectId, req.user!);
    ps = await db
      .select()
      .from(executionPlans)
      .where(eq(executionPlans.projectId, projectId))
      .orderBy(asc(executionPlans.createdAt));
  } else {
    // 直挂载：按可见项目过滤
    const visiblePids = await visibleProjectIds(req.user!);
    ps = visiblePids.length
      ? await db.select().from(executionPlans).where(inArray(executionPlans.projectId, visiblePids)).orderBy(asc(executionPlans.createdAt))
      : [];
  }
  const pcs = await db.select().from(planCases);
  const countByPlan = new Map<string, number>();
  for (const pc of pcs) countByPlan.set(pc.planId, (countByPlan.get(pc.planId) ?? 0) + 1);
  // 取 version 名称
  const vIds = Array.from(new Set(ps.map((p) => p.versionId).filter((v): v is string => !!v)));
  const vRows = vIds.length ? await db.select().from(projectVersions).where(inArray(projectVersions.id, vIds)) : [];
  const vName = new Map(vRows.map((v) => [v.id, v.name] as const));
  res.json(ps.map((p) => ({
    ...p,
    versionName: p.versionId ? vName.get(p.versionId) ?? null : null,
    caseCount: countByPlan.get(p.id) ?? 0,
  })));
});

plansRoute.post('/', async (req, res) => {
  const projectId = (req.params as { projectId?: string }).projectId;
  if (!projectId) throw new HttpError(400, 'bad_request', 'projectId is required');
  const body = CreateBody.parse(req.body);
  await assertProjectVisible(projectId, req.user!);
  // versionId 必填：前端所有入口都显式带版本，无隐式回退；传了则必须同 project
  const versionId = body.versionId;
  if (!versionId) throw new HttpError(400, 'version_required', 'versionId is required');
  {
    const { projectId: vp } = await assertVersionVisible(versionId, req.user!);
    if (vp !== projectId) throw new HttpError(400, 'version_mismatch', 'version does not belong to this project');
  }
  // 归属校验在 service 内重复一遍(有意冗余):AI 工具绕过 HTTP 层直调时无路由校验兜底
  res.json(await createPlan(projectId, { ...body, versionId }));
});

plansRoute.get('/:id', async (req, res) => {
  const detail = await getPlanDetail(req.params.id!);
  if (!detail) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(detail.projectId, req.user!);
  res.json(detail);
});

plansRoute.patch('/:id', async (req, res) => {
  const existing = (await db.select().from(executionPlans).where(eq(executionPlans.id, req.params.id)))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(existing.projectId, req.user!);
  const body = PatchBody.parse(req.body);
  // version/environment 归属(∈ 计划所属 project)由 service 兜底
  res.json(await updatePlan(req.params.id!, body));
});

plansRoute.delete('/:id', async (req, res) => {
  const existing = (await db.select().from(executionPlans).where(eq(executionPlans.id, req.params.id)))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(existing.projectId, req.user!);
  const deleted = await db.delete(executionPlans).where(eq(executionPlans.id, req.params.id)).returning();
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'plan not found');
  res.json({ ok: true });
});

// caseIds 归属(∈ 计划所属 project,409 cross_project)由 service assertCasesInProject 承接;
// 路由仅保留计划级 per-user 可见性。
plansRoute.put('/:id/cases', async (req, res) => {
  const { caseIds } = z.object({ caseIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
  const pid = await planProjectId(req.params.id!);
  if (!pid) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(pid, req.user!);
  await replacePlanCases(req.params.id!, caseIds);
  res.json({ ok: true });
});

plansRoute.put('/:id/cases/order', async (req, res) => {
  const { caseIds } = z.object({ caseIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
  const pid = await planProjectId(req.params.id!);
  if (!pid) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(pid, req.user!);
  await replacePlanCases(req.params.id!, caseIds);
  res.json({ ok: true });
});

plansRoute.delete('/:id/cases', async (req, res) => {
  const { caseIds } = z.object({ caseIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
  const pid = await planProjectId(req.params.id!);
  if (!pid) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(pid, req.user!);
  await removePlanCases(req.params.id!, caseIds);
  res.json({ ok: true });
});

plansRoute.get('/:id/login-cases', async (req, res) => {
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, req.params.id)))[0];
  if (!plan) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(plan.projectId, req.user!);
  const q = (req.query.q as string | undefined)?.trim().toLowerCase() ?? '';
  const groupId = req.query.groupId as string | undefined;
  const gs = await db.select().from(groups).where(eq(groups.projectId, plan.projectId));
  const gids = new Set(gs.map((g) => g.id));
  let rows = await db.select().from(testCases);
  rows = rows.filter((r) => gids.has(r.groupId));
  if (groupId) rows = rows.filter((r) => r.groupId === groupId);
  if (q) {
    const groupNameById = new Map(gs.map((g) => [g.id, g.name.toLowerCase()]));
    rows = rows.filter((r) => {
      if (r.title.toLowerCase().includes(q)) return true;
      return (groupNameById.get(r.groupId) ?? '').includes(q);
    });
  }
  res.json(rows.map((r) => ({ id: r.id, title: r.title, groupId: r.groupId })));
});

plansRoute.post('/:id/run', async (req, res) => {
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, req.params.id)))[0];
  if (!plan) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(plan.projectId, req.user!);
  if (plan.loginPrepareEnabled && !plan.loginCaseId) {
    // 无登录用例时允许环境登录凭据自动登录；计划环境连 login 对象都没有才算配置缺失
    let hasEnvLogin = false;
    if (plan.environmentId) {
      const objs = await db.select({ id: environmentObjects.id }).from(environmentObjects)
        .where(and(eq(environmentObjects.environmentId, plan.environmentId), eq(environmentObjects.objectType, 'login')))
        .limit(1);
      hasEnvLogin = objs.length > 0;
    }
    if (!hasEnvLogin) {
      throw new HttpError(422, 'login_case_required', '登录准备已开启：需选择登录用例，或在计划环境中配置登录凭据');
    }
  }
  if (plan.loginPrepareEnabled) {
    const incognitoIds = await findIncognitoCaseIds(plan.id);
    if (incognitoIds.length > 0) {
      throw new HttpError(422, 'incognito_conflicts_with_login_prepare', `cases: ${incognitoIds.join(',')}`);
    }
  }
  const ins = await db
    .insert(planRuns)
    .values({
      planId: plan.id,
      projectId: plan.projectId,
      status: 'running',
      strategy: plan.strategy,
      loginPrepareEnabled: plan.loginPrepareEnabled,
      loginCaseId: plan.loginCaseId,
      detectionUrl: plan.detectionUrl,
      loginSuccessSelector: plan.loginSuccessSelector,
      loginUnauthorizedKeywords: plan.loginUnauthorizedKeywords,
      totalCases: 0,
    })
    .returning();
  const runId = ins[0]!.id;
  // fire-and-forget
  void runPlanAsync({ planRunId: runId }).catch((e) => {
    logger.error({ err: e, planRunId: runId }, 'runPlanAsync crashed');
  });
  res.json({ runId });
});