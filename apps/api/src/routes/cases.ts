import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { testCases, groups, scenarios, projectVersions, projects, testSteps, solidifyBatches, solidifyBatchCases } from '../db/schema.js';
import { eq, inArray, sql } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';
import { assertCaseVisible, assertProductLineVisible, assertProjectVisible, assertVersionVisible, visibleProjectIds } from '../services/projectAccess.js';
import { copyCaseCore, createCase, deleteCase, getCaseDetail, groupProjectId, tagsForCases, updateCase } from '../services/cases.service.js';
import { attachCreators } from '../lib/creator.js';
import { checkBatchEligibility, RUNNING_BATCH_STATUSES, runSolidifyBatchCaseJob } from '../execute/batchSolidify.js';
import { getExecutionQueue, isExecutionQueueReady, EXEC_QUEUE_NAME } from '../scheduler/execQueue.js';
import { logger } from '../logger.js';

export const casesRoute = Router();

const CaseBodyBase = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).default('P1'),
  requirementId: z.string().uuid().optional(),
  groupId: z.string().uuid(),
  versionId: z.string().uuid().optional(),
  url: z.string().optional(),
  webServiceRef: z.string().max(64).nullable().optional(),
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
    webServiceRef: z.string().max(64).nullable().optional(),
    // 用例默认 environment id；null 表示清空，undefined 表示不动
    defaultEnvId: z.string().uuid().nullable().optional(),
    // 绑定数据集 id；null 表示解绑，undefined 表示不动
    datasetId: z.string().uuid().nullable().optional(),
    // 2026-10-07: 移动端支持
    platform: z.enum(['web', 'mobile']).optional(),
    mobileOs: z.enum(['ios', 'android']).nullable().optional(),
    mobileDeviceTargetId: z.string().uuid().nullable().optional(),
    appRef: z.object({
      bundleId: z.string().min(1).max(256),
      appPath: z.string().optional(),
      launchArgs: z.array(z.string()).max(50).optional(),
    }).nullable().optional(),
  })
  .superRefine(checkWindowStrategy);

casesRoute.get('/', async (req, res) => {
  const { priority, groupId, projectId, scenarioId, productLineId, solidified } = req.query as Record<string, string | undefined>;
  // versionIds 过滤：逗号分隔或重复参数均可；只在可见项目范围内收窄,无需额外可见性断言
  const rawVersionIds = (req.query as Record<string, string | string[] | undefined>).versionIds;
  const versionIds = (Array.isArray(rawVersionIds) ? rawVersionIds : rawVersionIds != null ? [rawVersionIds] : [])
    .flatMap((v) => v.split(','))
    .filter((v) => v.length > 0);
  let rows;
  if (productLineId) {
    // 产品线维度：一次拉齐线内所有项目的用例，供执行计划「添加用例」池使用
    // （跨项目共享用例的读取口。可见性经产品线→组织→visibleOrgIdsFor 继承，见 assertProductLineVisible）。
    await assertProductLineVisible(productLineId, req.user!);
    const pids = (await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.productLineId, productLineId))).map((p) => p.id);
    const gs = pids.length
      ? await db.select().from(groups).where(inArray(groups.projectId, pids))
      : [];
    const gids = gs.map((g) => g.id);
    rows = gids.length
      ? await db.select().from(testCases).where(inArray(testCases.groupId, gids))
      : [];
  } else if (projectId) {
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
  if (versionIds.length > 0) {
    const vset = new Set(versionIds);
    rows = rows.filter((r) => r.versionId != null && vset.has(r.versionId));
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
  // 批量回填步骤固化进度（total / compiled 非空数）：列表「固化」列与 ?solidified=none 筛选共用
  const stepsByCase = new Map<string, { total: number; compiled: number }>();
  if (caseIds.length > 0) {
    const agg = await db
      .select({
        caseId: testSteps.caseId,
        total: sql<number>`count(*)::int`,
        compiled: sql<number>`count(${testSteps.compiled})::int`,
      })
      .from(testSteps)
      .where(inArray(testSteps.caseId, caseIds))
      .groupBy(testSteps.caseId);
    for (const a of agg) stepsByCase.set(a.caseId, { total: a.total, compiled: a.compiled });
  }
  // 仅看未固化：有步骤且全部未固化（批量固化入口的口径；无步骤用例不算「未固化」）
  if (solidified === 'none') {
    rows = rows.filter((r) => {
      const s = stepsByCase.get(r.id);
      return (s?.total ?? 0) > 0 && (s?.compiled ?? 0) === 0;
    });
  }
  // 批量解析版本名：列表按项目拉取会跨版本混排，前端展示需要名字
  const vids = [...new Set(rows.map((r) => r.versionId).filter((v): v is string => !!v))];
  const vById = new Map<string, string>();
  if (vids.length > 0) {
    const vRows = await db
      .select({ id: projectVersions.id, name: projectVersions.name })
      .from(projectVersions)
      .where(inArray(projectVersions.id, vids));
    for (const v of vRows) vById.set(v.id, v.name);
  }
  // 批量回填所属项目（产品线维度下列表会跨项目混排，前端要靠它标「跨项目」并按项目筛选）
  const gidsAll = [...new Set(rows.map((r) => r.groupId).filter((v): v is string => !!v))];
  const projectByGroup = new Map<string, { id: string; name: string }>();
  if (gidsAll.length > 0) {
    const gs = await db
      .select({ id: groups.id, projectId: groups.projectId, projectName: projects.name })
      .from(groups)
      .innerJoin(projects, eq(projects.id, groups.projectId))
      .where(inArray(groups.id, gidsAll));
    for (const g of gs) projectByGroup.set(g.id, { id: g.projectId, name: g.projectName });
  }
  res.json(
    await attachCreators(
      rows.map((r) => {
        const p = projectByGroup.get(r.groupId);
        return {
          ...r,
          scenarioTitle: r.scenarioId ? (sById.get(r.scenarioId)?.title ?? null) : null,
          versionName: vById.get(r.versionId) ?? null,
          tags: tagsByCase.get(r.id) ?? [],
          stepsTotal: stepsByCase.get(r.id)?.total ?? 0,
          stepsCompiled: stepsByCase.get(r.id)?.compiled ?? 0,
          projectId: p?.id ?? null,
          projectName: p?.name ?? null,
        };
      }),
    ),
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
  res.json(await createCase({ ...body, versionId, createdByUserId: req.user!.userId }));
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
  if (body.datasetId !== undefined && body.datasetId !== null) {
    const { assertDatasetVisible } = await import('../services/projectAccess.js');
    await assertDatasetVisible(body.datasetId, req.user!);
  }
  // 2026-10-07: mobile platform 时 mobileOs/mobileDeviceTargetId/appRef 必须齐备（与已有字段合并判定）
  // platform=web 时清空 mobile 字段
  if (body.platform !== undefined) {
    const existing = await getCaseDetail(req.params.id!);
    if (body.platform === 'mobile') {
      const mOs = body.mobileOs ?? existing?.mobileOs ?? null;
      const mDt = body.mobileDeviceTargetId ?? existing?.mobileDeviceTargetId ?? null;
      const aRef = body.appRef ?? existing?.appRef ?? null;
      if (!mOs || !mDt || !aRef?.bundleId) {
        throw new HttpError(400, 'mobile_config_required', 'mobile case requires mobileOs, mobileDeviceTargetId, appRef.bundleId');
      }
    } else {
      // platform=web: 清空 mobile 字段(避免 web case 残留 mobile 配置)
      body.mobileOs = null;
      body.mobileDeviceTargetId = null;
      body.appRef = null;
    }
  }
  if (body.mobileDeviceTargetId !== undefined && body.mobileDeviceTargetId !== null) {
    const { assertDeviceTargetVisible } = await import('../services/projectAccess.js');
    await assertDeviceTargetVisible(body.mobileDeviceTargetId, req.user!);
  }
  // scenario 匹配 / env 归属 / tag 组织校验由 service 兜底
  res.json(await updateCase(req.params.id!, body));
});

async function copyOneCase(caseId: string, targetGroupId: string, targetVersionId: string | null, user: NonNullable<Express.Request['user']>): Promise<unknown> {
  const src = (await db.select().from(testCases).where(eq(testCases.id, caseId)))[0];
  if (!src) throw new HttpError(404, 'not_found', 'case not found');
  // 源 case 与目标分组所在项目都必须可见
  await assertCaseVisible(caseId, user);
  const targetGroup = (await db.select().from(groups).where(eq(groups.id, targetGroupId)))[0];
  if (targetGroup) await assertProjectVisible(targetGroup.projectId, user);
  // versionId 未传 → 同版本复制；否则校验属于 targetGroup.projectId
  if (targetVersionId) {
    const { projectId: vp } = await assertVersionVisible(targetVersionId, user);
    if (targetGroup && vp !== targetGroup.projectId) throw new HttpError(400, 'version_mismatch', 'version does not belong to target project');
  }
  return copyCaseCore({ caseId, targetGroupId, targetVersionId }, user.userId);
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

/**
 * 批量后端固化：全未固化 web 用例 NL→DSL + 机械验收，后台逐用例执行（job 粒度=单用例
 * solidify+materialize+verify 同 job：loginStateCache 进程内存缓存，跨副本拆分会退化成每步重新登录）。
 * 逐用例资格校验给人读原因；全部被拒 → 422 不建批次；部分被拒 → 200 + rejected 清单由前端提示。
 */
casesRoute.post('/batch-solidify', async (req, res) => {
  const body = z.object({ caseIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
  // 与 batch-delete 一致：先按可见性逐个校验，违规直接 404
  for (const id of body.caseIds) {
    await assertCaseVisible(id, req.user!);
  }
  const rejected: Array<{ caseId: string; reason: string }> = [];
  let batchProjectId: string | null = null;
  const accepted: string[] = [];
  for (const id of [...new Set(body.caseIds)]) {
    const c = await checkBatchEligibility(id);
    if (!c.ok) {
      rejected.push({ caseId: id, reason: c.reason });
      continue;
    }
    // 批次挂单一项目（触发入口为分组页，实际恒同项目）；跨项目混选把异项目用例归入 rejected
    if (batchProjectId === null) batchProjectId = c.projectId;
    else if (batchProjectId !== c.projectId) {
      rejected.push({ caseId: id, reason: '与其它用例不在同一项目，请分项目触发' });
      continue;
    }
    accepted.push(id);
  }
  // 全部被拒也回 200（batchId=null）：api client 对非 2xx 抛 ApiError 会丢掉 rejected 明细，
  // 前端靠 batchId 判空决定是否轮询（与部分被拒 200 同一契约）
  if (accepted.length === 0 || batchProjectId === null) {
    res.json({ batchId: null, accepted: [], rejected });
    return;
  }
  const batch = (
    await db.insert(solidifyBatches).values({ projectId: batchProjectId, createdByUserId: req.user!.userId }).returning({ id: solidifyBatches.id })
  )[0]!;
  await db.insert(solidifyBatchCases).values(accepted.map((caseId) => ({ batchId: batch.id, caseId })));
  // 逐用例入队；无 redis（或 add reject）回落 inline，同 execute.ts 模式
  for (const caseId of accepted) {
    if (isExecutionQueueReady()) {
      try {
        await getExecutionQueue().add(EXEC_QUEUE_NAME, { kind: 'solidify', batchId: batch.id, caseId });
      } catch (e) {
        logger.warn({ err: e, batchId: batch.id, caseId }, 'exec queue add failed; running solidify inline');
        void runSolidifyBatchCaseJob({ batchId: batch.id, caseId });
      }
    } else {
      void runSolidifyBatchCaseJob({ batchId: batch.id, caseId });
    }
  }
  res.json({ batchId: batch.id, accepted, rejected });
});

/**
 * 批量固化进度查询（前端 2s 轮询口）。批量状态读时派生：
 * 有 running 行 = running；否则全过 = passed、全败 = failed、混合 = partial。
 */
casesRoute.get('/solidify-batches/:id', async (req, res) => {
  const batch = (await db.select().from(solidifyBatches).where(eq(solidifyBatches.id, req.params.id!)).limit(1))[0];
  if (!batch) throw new HttpError(404, 'not_found', 'batch not found');
  await assertProjectVisible(batch.projectId, req.user!);
  const rows = await db
    .select({
      caseId: solidifyBatchCases.caseId,
      status: solidifyBatchCases.status,
      error: solidifyBatchCases.error,
      title: testCases.title,
    })
    .from(solidifyBatchCases)
    .innerJoin(testCases, eq(testCases.id, solidifyBatchCases.caseId))
    .where(eq(solidifyBatchCases.batchId, batch.id));
  const passed = rows.filter((r) => r.status === 'passed').length;
  const failed = rows.filter((r) => r.status.endsWith('_failed')).length;
  const running = rows.filter((r) => (RUNNING_BATCH_STATUSES as readonly string[]).includes(r.status)).length;
  const status = running > 0 ? 'running' : failed === 0 ? 'passed' : passed === 0 ? 'failed' : 'partial';
  res.json({ batchId: batch.id, status, total: rows.length, passed, failed, running, cases: rows });
});
