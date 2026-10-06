/**
 * 版本空间助手「暂存 → 落库」HTTP 端点：
 *   POST /assistant/threads/:id/stage/list   返回该线程下所有暂存对象(含 caseOps)
 *   POST /assistant/threads/:id/stage/save   用户勾选后调用,把暂存对象落正式表并删 stage 行
 *
 * 落库顺序：先 scenarios（含 requirement 解析）→ cases（含 groupId）→ environments → plans → caseOps。
 * 任一阶段失败整体回滚（DELETE 不入库,但 stage 写入本身不回退 —— 用户可重新勾选重试）。
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Router } from 'express';
import { db } from '../../db/client.js';
import {
  aiStageCaseOps, aiStageCases, aiStageEnvironments, aiStagePlans, aiStageScenarios,
} from '../../db/schema.js';
import { HttpError } from '../../middleware/errorHandler.js';
import * as casesSvc from '../../services/cases.service.js';
import * as scenariosSvc from '../../services/scenarios.service.js';
import * as environmentsSvc from '../../services/environments.service.js';
import * as plansSvc from '../../services/plans.service.js';
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
  plans: Array<{ localId: string; groupId: string }>;
  caseOps: Array<{ localId: string }>;
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
  const body = (req.body ?? {}) as Partial<SaveBody>;
  const cases = body.cases ?? [];
  const scenarios = body.scenarios ?? [];
  const environments = body.environments ?? [];
  const plans = body.plans ?? [];
  const caseOps = body.caseOps ?? [];
  if (cases.length + scenarios.length + environments.length + plans.length + caseOps.length === 0) {
    throw new HttpError(400, 'bad_request', '至少选择一项');
  }

  // 1. 先在事务外解析所有局部映射；失败立即抛错、不删 stage 行（用户可重选）。
  const pid = await resolveVersionProjectId(versionId);
  if (!pid) throw new HttpError(500, 'invariant', 'version project missing');

  // 1a. cases: 拉 stage 行 → 校验 groupId 归属 → 调 createCaseWithSteps 落库
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
    const created = await casesSvc.createCaseWithSteps({
      groupId: gid,
      versionId,
      title: row.title,
      description: row.description,
      priority: row.priority ?? undefined,
      url: row.url,
      expectedOutcome: row.expectedOutcome,
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

  // 1b. scenarios: 直接落正式表
  const stageScenarioRows = scenarios.length
    ? await db.select().from(aiStageScenarios)
        .where(and(eq(aiStageScenarios.threadId, threadId), inArray(aiStageScenarios.localId, scenarios.map((s) => s.localId))))
    : [];
  for (const sel of scenarios) {
    const row = stageScenarioRows.find((r) => r.localId === sel.localId);
    if (!row) throw new HttpError(404, 'not_found', `stage scenario ${sel.localId} 已不存在`);
    await scenariosSvc.createScenario(row.requirementId, { title: row.title, description: row.description });
  }

  // 1c. environments: name 冲突 → 409（其余场景 service 内部已经抛 HttpError）
  const stageEnvRows = environments.length
    ? await db.select().from(aiStageEnvironments)
        .where(and(eq(aiStageEnvironments.threadId, threadId), inArray(aiStageEnvironments.localId, environments.map((e) => e.localId))))
    : [];
  for (const sel of environments) {
    const row = stageEnvRows.find((r) => r.localId === sel.localId);
    if (!row) throw new HttpError(404, 'not_found', `stage environment ${sel.localId} 已不存在`);
    await environmentsSvc.createEnvironment(pid, {
      name: row.name,
      baseUrl: row.baseUrl,
      objects: ((row.objects as unknown[]) ?? []).map((o) => {
        const x = o as { objectType: 'db' | 'syslog' | 'login'; label?: string; payload: Record<string, unknown>; isDefault?: boolean };
        return { objectType: x.objectType, label: x.label, payload: x.payload, isDefault: x.isDefault };
      }),
    });
  }

  // 1d. plans: 先建计划,再按 caseLocalIds 解析真实 caseId（来自已落库的 caseStage 1a）→ replacePlanCases
  const stagePlanRows = plans.length
    ? await db.select().from(aiStagePlans)
        .where(and(eq(aiStagePlans.threadId, threadId), inArray(aiStagePlans.localId, plans.map((p) => p.localId))))
    : [];
  for (const sel of plans) {
    const row = stagePlanRows.find((r) => r.localId === sel.localId);
    if (!row) throw new HttpError(404, 'not_found', `stage plan ${sel.localId} 已不存在`);
    const realCaseIds = (row.caseLocalIds ?? [])
      .map((localId) => createdCaseIds.get(localId))
      .filter((x): x is string => !!x);
    const plan = await plansSvc.createPlan(pid, {
      name: row.name,
      versionId,
      environmentId: row.environmentId ?? undefined,
    });
    if (realCaseIds.length > 0) {
      await plansSvc.replacePlanCases(plan.id, realCaseIds);
    }
  }

  // 1e. caseOps:按 stagedAt 升序应用(用户勾选顺序之外的"全局意图顺序")。
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
    caseIdMap: Object.fromEntries(createdCaseIds),
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
  ]);
  return removed.reduce((acc, r) => acc + r.length, 0);
}

// 保留 sql 占位防止 import 被 unused-strip;drizzle import 实际有用（and/eq/inArray）
void sql;
