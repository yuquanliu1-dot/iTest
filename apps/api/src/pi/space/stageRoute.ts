/**
 * 版本空间助手「暂存 → 落库」HTTP 端点：
 *   POST /assistant/threads/:id/stage/list   返回该线程下所有暂存对象(含 caseOps)
 *   POST /assistant/threads/:id/stage/save   用户勾选后调用,把暂存对象落正式表并删 stage 行
 *
 * 落库顺序：先 datasets（cases 的 datasetLocalId 依赖真实 id）→ scenarios（含 requirement 解析）→ cases（含 groupId）→ environments → plans → caseOps。
 * 任一阶段失败整体回滚（DELETE 不入库,但 stage 写入本身不回退 —— 用户可重新勾选重试）。
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Router } from 'express';
import { db } from '../../db/client.js';
import {
  aiStageCaseOps, aiStageCases, aiStageDatasets, aiStageEnvironments, aiStagePlans, aiStageScenarios, groups, testCases,
} from '../../db/schema.js';
import { HttpError } from '../../middleware/errorHandler.js';
import * as casesSvc from '../../services/cases.service.js';
import * as scenariosSvc from '../../services/scenarios.service.js';
import * as environmentsSvc from '../../services/environments.service.js';
import * as plansSvc from '../../services/plans.service.js';
import * as datasetsSvc from '../../services/datasets.service.js';
import { resolveVersionProjectId } from '../../services/projectAccess.js';
import { emitThreadEvent } from './session.js';
import {
  deleteStaged, listStage, type StageDoc, type StageKind, type StagedCaseOp,
} from './tools/stage-tools.js';
import { applyCaseOp, type SpaceToolsContext } from './tools/case-ops-tools.js';
import { emptyRepoState } from './tools/context.js';
import { assertSpaceThreadVisible } from './router.js';

export const stageRoute = Router();

interface SaveBody {
  cases: Array<{ localId: string; groupId: string }>;
  scenarios: Array<{ localId: string }>;
  environments: Array<{ localId: string }>;
  plans: Array<{ localId: string }>;
  caseOps: Array<{ localId: string }>;
  datasets: Array<{ localId: string }>;
}

function emitStageRemove(threadId: string, kind: StageKind, localId: string): void {
  emitThreadEvent(threadId, { type: 'stage', kind, id: localId, action: 'remove' });
}

stageRoute.post('/threads/:id/stage/list', async (req, res) => {
  const threadId = req.params.id!;
  await assertSpaceThreadVisible(threadId, req.user as never);
  const doc: StageDoc = await listStage(threadId);
  res.json(doc);
});

stageRoute.post('/threads/:id/stage/save', async (req, res) => {
  const threadId = req.params.id!;
  const versionId = await assertSpaceThreadVisible(threadId, req.user as never);
  // 暂存落库对象以当前操作用户为创建人（AI 代建路径的归属）。
  const creatorId = (req.user as { userId?: string } | undefined)?.userId ?? null;
  const body = (req.body ?? {}) as Partial<SaveBody>;
  const cases = body.cases ?? [];
  const scenarios = body.scenarios ?? [];
  const environments = body.environments ?? [];
  const plans = body.plans ?? [];
  const caseOps = body.caseOps ?? [];
  const datasets = body.datasets ?? [];
  if (cases.length + scenarios.length + environments.length + plans.length + caseOps.length + datasets.length === 0) {
    throw new HttpError(400, 'bad_request', '至少选择一项');
  }

  // 1. 先在事务外解析所有局部映射；失败立即抛错、不删 stage 行（用户可重选）。
  const pid = await resolveVersionProjectId(versionId);
  if (!pid) throw new HttpError(500, 'invariant', 'version project missing');

  // 1a. datasets: 先于 cases 落库（stage_case.datasetLocalId 需要真实 datasetId 回填）。
  //  rows 是明文草稿（含 sensitive 列）→ createDataset/normalizeDataset 在这里完成加密。
  //  名称冲突 409 由 service 抛出,用户改名后可重试。
  const stageDatasetRows = datasets.length
    ? await db.select().from(aiStageDatasets)
        .where(and(eq(aiStageDatasets.threadId, threadId), inArray(aiStageDatasets.localId, datasets.map((d) => d.localId))))
    : [];
  const createdDatasetIds = new Map<string, string>(); // staged localId → real datasetId
  for (const sel of datasets) {
    const row = stageDatasetRows.find((r) => r.localId === sel.localId);
    if (!row) throw new HttpError(404, 'not_found', `stage dataset ${sel.localId} 已不存在,请刷新重试`);
    const created = await datasetsSvc.createDataset(pid, {
      name: row.name,
      description: row.description,
      columns: (row.columns ?? []) as Array<{ name: string; sensitive?: boolean }>,
      rows: (row.rows ?? []) as Array<{ disabled?: boolean; cells: Record<string, unknown> }>,
    }, creatorId);
    createdDatasetIds.set(sel.localId, created.id);
  }

  // 1b. cases: 拉 stage 行 → 校验 groupId 归属 → 调 createCaseWithSteps 落库
  const stageCaseRows = cases.length
    ? await db.select().from(aiStageCases)
        .where(and(eq(aiStageCases.threadId, threadId), inArray(aiStageCases.localId, cases.map((c) => c.localId))))
    : [];
  const caseByLocalId = new Map(stageCaseRows.map((r) => [r.localId, r]));
  const createdCaseIds = new Map<string, string>(); // staged localId → real caseId
  for (const sel of cases) {
    const row = caseByLocalId.get(sel.localId);
    if (!row) throw new HttpError(404, 'not_found', `stage case ${sel.localId} 已不存在,请刷新重试`);
    const gid = sel.groupId;
    const gidPid = await casesSvc.groupProjectId(gid);
    if (!gidPid) throw new HttpError(404, 'not_found', `group ${gid} 不存在`);
    if (gidPid !== pid) throw new HttpError(400, 'cross_project', `group ${gid} 不属于当前项目`);
    // 配套数据集绑定：datasetLocalId 仅在本批 datasets 里解析;未勾选/未找到则跳过绑定（沿 plans caseLocalIds 先例）。
    const datasetId = row.datasetLocalId ? createdDatasetIds.get(row.datasetLocalId) : undefined;
    const created = await casesSvc.createCaseWithSteps({
      groupId: gid,
      versionId,
      title: row.title,
      description: row.description,
      priority: row.priority ?? undefined,
      url: row.url,
      expectedOutcome: row.expectedOutcome,
      coverageTypes: (row.coverageTypes ?? []) as string[],
      datasetId: datasetId ?? undefined,
      createdByUserId: creatorId,
      steps: ((row.steps as unknown[]) ?? []).map((s) => {
        const o = s as { action?: unknown; assertion?: unknown; compiled?: unknown };
        return {
          instruction: typeof o.action === 'string' ? o.action : '',
          assertion: typeof o.assertion === 'string' ? o.assertion : null,
          compiled: Array.isArray(o.compiled) ? o.compiled : undefined,
        };
      }),
    });
    createdCaseIds.set(sel.localId, created.id);
  }

  // 1c. scenarios: 直接落正式表
  const stageScenarioRows = scenarios.length
    ? await db.select().from(aiStageScenarios)
        .where(and(eq(aiStageScenarios.threadId, threadId), inArray(aiStageScenarios.localId, scenarios.map((s) => s.localId))))
    : [];
  for (const sel of scenarios) {
    const row = stageScenarioRows.find((r) => r.localId === sel.localId);
    if (!row) throw new HttpError(404, 'not_found', `stage scenario ${sel.localId} 已不存在`);
    await scenariosSvc.createScenario(row.requirementId, { title: row.title, description: row.description });
  }

  // 1d. environments: name 冲突 → 409（其余场景 service 内部已经抛 HttpError）
  const stageEnvRows = environments.length
    ? await db.select().from(aiStageEnvironments)
        .where(and(eq(aiStageEnvironments.threadId, threadId), inArray(aiStageEnvironments.localId, environments.map((e) => e.localId))))
    : [];
  for (const sel of environments) {
    const row = stageEnvRows.find((r) => r.localId === sel.localId);
    if (!row) throw new HttpError(404, 'not_found', `stage environment ${sel.localId} 已不存在`);
    const insertedEnv = await environmentsSvc.createEnvironment(pid, {
      name: row.name,
      baseUrl: row.baseUrl,
      objects: ((row.objects as unknown[]) ?? []).map((o) => {
        const x = o as { objectType: 'db' | 'syslog' | 'login' | 'web'; label?: string; payload: Record<string, unknown>; isDefault?: boolean };
        return { objectType: x.objectType, label: x.label, payload: x.payload, isDefault: x.isDefault };
      }),
    }, creatorId);
    // staged.baseUrl 绝对地址 → 派生默认 web 服务对象(尽力而为:解析失败跳过,不阻塞 save)。
    // 用例 url 相对化后靠 web 对象 origin 拼接,老数据仍在 baseUrl 的暂存环境需要这个兜底。
    if (insertedEnv && row.baseUrl && /^https?:\/\//.test(row.baseUrl)) {
      try {
        const u = new URL(row.baseUrl);
        await environmentsSvc.insertEnvironmentObject(insertedEnv.id, {
          objectType: 'web',
          label: '默认 Web',
          payload: { name: 'web', scheme: u.protocol === 'https:' ? 'https' : 'http', host: u.hostname, ...(u.port ? { port: Number(u.port) } : {}) },
          isDefault: true,
        });
      } catch {
        /* 尽力而为:解析失败跳过,不阻塞 save */
      }
    }
  }

  // 1e. plans: 先建计划,再按 caseLocalIds 解析真实 caseId。
  //  - caseLocalIds 允许两种来源：①本批暂存的用例（localId 来自 1b）→ createdCaseIds 映射；
  //    ②LLM 直接给的真实 caseId（来自 manage_cases search/get）→ 在 project 内 lookup。
  //  这样「引用已有用例」与「暂存用例」混用都能正确落库；解析失败的 localId 抛错并点名。
  const stagePlanRows = plans.length
    ? await db.select().from(aiStagePlans)
        .where(and(eq(aiStagePlans.threadId, threadId), inArray(aiStagePlans.localId, plans.map((p) => p.localId))))
    : [];
  const referencedLocalIds = Array.from(new Set(stagePlanRows.flatMap((r) => r.caseLocalIds ?? [])));
  const existingCaseIdSet = new Set<string>();
  const missingFromBatch = referencedLocalIds.filter((lid) => !createdCaseIds.has(lid));
  if (missingFromBatch.length) {
    const realIds = await db
      .select({ id: testCases.id })
      .from(testCases)
      .innerJoin(groups, eq(groups.id, testCases.groupId))
      .where(and(inArray(testCases.id, missingFromBatch), eq(groups.projectId, pid)));
    for (const r of realIds) existingCaseIdSet.add(r.id);
  }
  for (const sel of plans) {
    const row = stagePlanRows.find((r) => r.localId === sel.localId);
    if (!row) throw new HttpError(404, 'not_found', `stage plan ${sel.localId} 已不存在`);
    const realCaseIds: string[] = [];
    const unresolved: string[] = [];
    for (const localId of row.caseLocalIds ?? []) {
      const realId = createdCaseIds.get(localId) ?? (existingCaseIdSet.has(localId) ? localId : undefined);
      if (realId) realCaseIds.push(realId);
      else unresolved.push(localId);
    }
    if (unresolved.length > 0) {
      throw new HttpError(400, 'unresolved_case', `计划「${row.name}」引用了未勾选/不存在的用例:${unresolved.join('、')};请在用例 Tab 勾选后重试,或从计划中移除引用`);
    }
    const plan = await plansSvc.createPlan(pid, {
      name: row.name,
      versionId,
      environmentId: row.environmentId ?? undefined,
    }, creatorId);
    if (realCaseIds.length > 0) {
      await plansSvc.replacePlanCases(plan.id, realCaseIds);
    }
  }

  // 1f. caseOps:按 stagedAt 升序应用(用户勾选顺序之外的"全局意图顺序")。
  //  - 步骤级 op（update_step/insert_step/delete_step/move_step）天然在同一 case 内,顺序按 stagedAt 即可;
  //    跨 case 不保证事务(失败回退不跨用例)—— 单 case 内 insert/delete/move_step 由 case-ops-tools.applyCaseOp 包 transaction。
  //  - 用例级 op(update_case/delete_case/move_case):delete 会级联删 steps,后续对已删 case 的 step op 会失败(用户应在前置勾选里把 step op 一起勾)—— 不做复杂重排。
  const stageCaseOpRows = caseOps.length
    ? (await db.select().from(aiStageCaseOps)
        .where(and(eq(aiStageCaseOps.threadId, threadId), inArray(aiStageCaseOps.localId, caseOps.map((c) => c.localId))))
        .orderBy(asc(aiStageCaseOps.stagedAt))) as unknown as Array<StagedCaseOp & { stagedAt: string }>
    : [];
  const projectId = pid; // for applyCaseOp ctx
  for (const row of stageCaseOpRows) {
    const ctx: SpaceToolsContext = {
      threadId,
      versionId,
      projectId,
      repo: emptyRepoState(),
      emit: (e: unknown) => emitThreadEvent(threadId, e as Record<string, unknown>),
      createdByUserId: creatorId,
    };
    await applyCaseOp(row.op, row.payload, ctx);
  }

  // 2. 全部成功后删 stage 行 + 广播 remove 事件（前端清空勾选状态）
  const localIdsByKind: Array<{ kind: StageKind; localIds: string[] }> = [
    { kind: 'case', localIds: cases.map((c) => c.localId) },
    { kind: 'scenario', localIds: scenarios.map((s) => s.localId) },
    { kind: 'environment', localIds: environments.map((e) => e.localId) },
    { kind: 'plan', localIds: plans.map((p) => p.localId) },
    { kind: 'case_op', localIds: caseOps.map((c) => c.localId) },
    { kind: 'dataset', localIds: datasets.map((d) => d.localId) },
  ];
  for (const { kind, localIds } of localIdsByKind) {
    if (localIds.length === 0) continue;
    await deleteStaged(threadId, [kind], localIds);
    for (const lid of localIds) emitStageRemove(threadId, kind, lid);
  }

  res.json({
    savedCases: cases.length,
    savedScenarios: scenarios.length,
    savedEnvironments: environments.length,
    savedPlans: plans.length,
    savedCaseOps: caseOps.length,
    savedDatasets: datasets.length,
    caseIdMap: Object.fromEntries(createdCaseIds),
    datasetIdMap: Object.fromEntries(createdDatasetIds),
  });
});

/** 静默清理孤儿占位 stage 行（兜底,正常路径用不到）。 */
export async function purgeStaleStages(threadId: string): Promise<number> {
  const removed = await Promise.all([
    db.delete(aiStageCases).where(eq(aiStageCases.threadId, threadId)).returning({ id: aiStageCases.localId }),
    db.delete(aiStageScenarios).where(eq(aiStageScenarios.threadId, threadId)).returning({ id: aiStageScenarios.localId }),
    db.delete(aiStageEnvironments).where(eq(aiStageEnvironments.threadId, threadId)).returning({ id: aiStageEnvironments.localId }),
    db.delete(aiStagePlans).where(eq(aiStagePlans.threadId, threadId)).returning({ id: aiStagePlans.localId }),
    db.delete(aiStageCaseOps).where(eq(aiStageCaseOps.threadId, threadId)).returning({ id: aiStageCaseOps.localId }),
    db.delete(aiStageDatasets).where(eq(aiStageDatasets.threadId, threadId)).returning({ id: aiStageDatasets.localId }),
  ]);
  return removed.reduce((acc, r) => acc + r.length, 0);
}

// 保留 sql 占位防止 import 被 unused-strip;drizzle import 实际有用（and/eq/inArray）
void sql;
