/**
 * stage_case_op：对「已有用例/步骤」的修改统一走暂存 → StagePanel 勾选 → 落库。
 * 替换原 manage_cases.update/delete/move_group 的实时落库 + ConfirmCard，与 aiStep/solveCaptcha 旧 kind 同方向的清理。
 *
 * 单工具多 action（与 manage_cases.action 字段先例一致，省一个工具 schema 多轮）：
 *   - update_case   {caseId, patch: UpdateCasePatch}     → 走 svc.updateCase
 *   - delete_case   {caseId}                            → 走 svc.deleteCase（落库时执行，前端在 StagePanel 已勾选）
 *   - move_case     {caseId, targetGroupId}              → 走 svc.updateCase({groupId})
 *   - update_step   {stepId, instruction?, compiled?}    → 走 svc.updateCaseStep
 *   - insert_step   {caseId, instruction, afterOrder?, compiled?} → 走 svc.insertCaseStep
 *   - delete_step   {stepId}                            → 删 + 后续步骤 order 紧凑化
 *   - move_step     {caseId, stepIds}                   → 1..n 重排（照 routes/steps.ts:117-130）
 *
 * compiled 防御校验复用 normalizeCompiledStep（pi/tools.ts）+ z.array(StepAction).min(1)。
 * 归属：detail.versionId === ctx.versionId。
 */
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import { StepAction } from '@itest/shared';
import { db } from '../../../db/client.js';
import { aiStageCaseOps, datasets, testSteps } from '../../../db/schema.js';
import * as svc from '../../../services/cases.service.js';
import { buildVariableReport } from '../../../lib/variable-report.js';
import { normalizeCompiledStep } from '../../tools.js';
import { HttpError } from '../../../middleware/errorHandler.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';
import { emitStage } from './stage.js';
import { diffText } from './diff.js';
import type { StageKind } from './stage-tools.js';
export type { SpaceToolsContext } from './context.js';

// ─────────────────────────────────────────────────────────────────────────────
// 类型 + zod 校验
// ─────────────────────────────────────────────────────────────────────────────

const StepActionShape = z.object({
  kind: z.string().min(1),
}).passthrough();

const CompiledNullableArray = z
  .preprocess((v) => {
    if (v === null) return null;
    if (!Array.isArray(v)) return v;
    if (v.length === 0) return null; // 空数组 == 放弃
    return v.map(normalizeCompiledStep);
  }, z.array(StepAction).min(1).nullable());

const UpdateCasePatchShape = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).nullable().optional(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
  status: z.enum(['draft', 'review', 'ready', 'deprecated']).optional(),
  url: z.string().max(2000).nullable().optional(),
  expectedOutcome: z.string().max(4000).nullable().optional(),
  defaultEnvId: z.string().uuid().nullable().optional(),
  datasetId: z.string().uuid().nullable().optional(),
});

const CaseOpBase = {
  caseId: z.string().uuid(),
};

const StageCaseOpInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('update_case'), ...CaseOpBase, patch: UpdateCasePatchShape }),
  z.object({ action: z.literal('delete_case'), ...CaseOpBase }),
  z.object({ action: z.literal('move_case'), ...CaseOpBase, targetGroupId: z.string().uuid() }),
  z.object({
    action: z.literal('update_step'),
    stepId: z.string().uuid(),
    caseId: z.string().uuid(),
    instruction: z.string().min(1).max(2000).optional(),
    compiled: CompiledNullableArray.optional(),
  }),
  z.object({
    action: z.literal('insert_step'),
    ...CaseOpBase,
    instruction: z.string().min(1).max(2000),
    afterOrder: z.number().int().nonnegative().optional(),
    compiled: CompiledNullableArray.optional(),
  }),
  z.object({ action: z.literal('delete_step'), stepId: z.string().uuid(), caseId: z.string().uuid() }),
  z.object({ action: z.literal('move_step'), ...CaseOpBase, stepIds: z.array(z.string().uuid()).min(1) }),
]);

export type StageCaseOpInput = z.infer<typeof StageCaseOpInput>;

// ─────────────────────────────────────────────────────────────────────────────
// 工具集：暂存 → aiStageCaseOps 表 + 广播 stage 事件
// ─────────────────────────────────────────────────────────────────────────────

export const STAGE_CASE_OP_GUIDELINES = [
  '修改已有用例（更新元数据 / 删除 / 移动分组）或编辑已有用例的步骤（重编译 / 改 instruction / 插入 / 删除 / 排序）时，统一调用 stage_case_op；用户在右侧 StagePanel 勾选确认后才落库。',
  '不要直接调用 manage_cases 的 update/delete/move_group —— 那些场景已下线。manage_cases 只剩 search/get/create_group。',
  '不要用 stage_case / manage_cases.create 修改已有用例 —— stage_case 是创建全新用例的，请用 action=update_case/move_case。',
  '在生成 compiled 前，先调用 manage_cases get 拿 caseId/versionId/expectedOutcome/steps 全量，再用 inspect_page 抓真实页面元素（locator 的 testId/aria-label/css 必须取自快照，禁止凭"典型实现"臆造）。',
  'compiled 是 JSON 数组（元素形如 {kind, ...}），允许 kind：navigate / click / fill / hover / waitFor / assertText / assertVisible / check / select / extract / aiTask（动态验证码/弹窗等用 aiTask，不要用普通 fill）。禁止输出 aiStep。',
  'case 的「初始化导航 URL」(case.url) 回放开始时已由系统执行,update_step / insert_step 的 compiled 里不要再写一条 {kind:"navigate", url: case.url} —— 重复导航既慢又让 locator 校验做两遍。真的意图是跳到不同页面/子路由时才写 navigate(url=目标 URL)。',
  '若判断无法可靠编译（指令过于模糊），把 compiled 设为 null 表示「已放弃」。空数组也会被映射为 null（回放里等价于「什么都不做」会隐藏失败）。',
  'stage_case_op 的 action 与字段一一对应：update_case {caseId, patch={...UpdateCasePatch 形状字段}}、delete_case {caseId}、move_case {caseId, targetGroupId}、update_step {stepId, caseId, instruction?, compiled?}、insert_step {caseId, instruction, afterOrder?, compiled?}、delete_step {stepId, caseId}、move_step {caseId, stepIds}。move_step 的 stepIds 必须恰好覆盖该 case 全部步骤并按目标顺序排列。',
  'localId 由你（LLM）用 UUID v4 自生成；同 localId 重复 stage 是幂等 UPSERT，可放心重发。',
  '用例绑定/解绑数据集走 update_case(patch.datasetId)（跨项目数据集会被拒绝）；数据集列名即回放初始变量 {{列名}}，insert_step/update_step 响应会附「变量体检」反馈，引用未定义变量时请修正 compiled 或先确认数据集列名（manage_cases list_datasets / get）。',
];

interface StagedCaseOpDoc {
  localId: string;
  caseId: string;
  op: string;
  payload: unknown;
  summary: string;
  diff?: string;
  stagedAt: string;
}

function genLocalId(): string {
  return (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36));
}

async function loadCaseOrThrow(ctx: SpaceToolsContext, caseId: string) {
  const detail = await svc.getCaseDetail(caseId);
  if (!detail) throw new HttpError(404, 'not_found', `case ${caseId} not found`);
  if (detail.versionId !== ctx.versionId) {
    throw new HttpError(404, 'not_found', `case ${caseId} not in this version`);
  }
  return detail;
}

function summaryFor(input: StageCaseOpInput, before: Awaited<ReturnType<typeof svc.getCaseDetail>>): { summary: string; diff?: string } {
  const title = before?.title ?? '用例';
  switch (input.action) {
    case 'update_case': {
      const keys = Object.keys(input.patch);
      const summary = `更新「${title}」(${keys.join('/')})`;
      const after = { ...before, ...input.patch };
      return { summary, diff: diffText(before ?? {}, after as Record<string, unknown>) };
    }
    case 'delete_case':
      return { summary: `删除「${title}」` };
    case 'move_case':
      return { summary: `移动「${title}」到分组 ${input.targetGroupId}`, diff: `groupId: ${before?.groupId ?? '?'} → ${input.targetGroupId}` };
    case 'update_step': {
      const step = before?.steps.find((s) => s.id === input.stepId);
      const order = step?.order ?? '?';
      const willChange: string[] = [];
      if (input.instruction !== undefined) willChange.push('instruction');
      if (input.compiled !== undefined) willChange.push('compiled');
      const summary = `更新步骤 #${order}（${willChange.join('+') || 'noop'}）`;
      const afterStep = { ...step, instruction: input.instruction ?? step?.instruction, compiled: input.compiled ?? step?.compiled };
      const diff = diffText({ instruction: step?.instruction, compiled: step?.compiled }, { instruction: afterStep?.instruction, compiled: afterStep?.compiled });
      return { summary, diff };
    }
    case 'insert_step': {
      const target = input.afterOrder !== undefined ? `#${input.afterOrder} 后` : '末尾';
      return { summary: `在${target} 插入新步骤` };
    }
    case 'delete_step': {
      const step = before?.steps.find((s) => s.id === input.stepId);
      return { summary: `删除步骤 #${step?.order ?? '?'}` };
    }
    case 'move_step':
      return { summary: `重排 ${input.stepIds.length} 个步骤` };
  }
}

/** 步骤写 op 的前瞻变量体检：按 op 虚拟应用后的全量 compiled 动作计算（含绑定数据集列作为初始变量），
 *  以文本附在暂存响应里给 AI 自校验 —— 写完 {{var}} 立刻知道有没有写错，而不是回放才发现。 */
async function prospectiveVarNote(
  before: Awaited<ReturnType<typeof svc.getCaseDetail>> | null,
  v: Extract<StageCaseOpInput, { action: 'insert_step' | 'update_step' }>,
): Promise<string> {
  if (!before) return '';
  const steps = [...before.steps];
  if (v.action === 'update_step') {
    const i = steps.findIndex((s) => s.id === v.stepId);
    if (i >= 0) steps[i] = { ...steps[i]!, compiled: v.compiled === undefined ? steps[i]!.compiled : v.compiled } as (typeof steps)[number];
  } else {
    // 与真实 insertCaseStep 对齐：afterOrder 之后插入；越界（>= maxOrder）时落到末尾而非队首。
    const at = v.afterOrder !== undefined ? steps.filter((s) => s.order <= v.afterOrder).length : steps.length;
    const maxOrder = steps.reduce((m, s) => Math.max(m, s.order), 0);
    steps.splice(at, 0, { id: 'staged', order: maxOrder + 1, instruction: v.instruction, compiled: v.compiled ?? [] } as unknown as (typeof steps)[number]);
  }
  const actions = steps.flatMap((s): StepAction[] => {
    const c = s.compiled as unknown[] | null | undefined;
    return Array.isArray(c) ? c.filter((a): a is StepAction => !!((a as { kind?: string }).kind)) : [];
  });
  let initialVars: string[] | undefined;
  const dsId = (before as { datasetId?: string | null }).datasetId;
  if (dsId) {
    const ds = (await db.select().from(datasets).where(eq(datasets.id, dsId)).limit(1))[0];
    if (ds) initialVars = ds.columns.map((c) => c.name);
  }
  const report = buildVariableReport(actions, initialVars);
  const notes = [
    ...report.undefined.map((x) => `引用未定义变量 {{${x.name}}}(${x.field})`),
    ...report.forwardRefs.map((x) => `前向引用 {{${x.name}}}`),
    ...report.invalidNames.map((x) => `变量名 ${x.name} 不合法`),
  ];
  return notes.length > 0 ? `变量体检:${notes.join(';')}` : '变量体检:通过';
}

export async function stageCaseOp(threadId: string, versionId: string, body: StagedCaseOpDoc & { caseId: string; op: string; payload: unknown }): Promise<void> {
  await db
    .insert(aiStageCaseOps)
    .values({
      threadId,
      localId: body.localId,
      versionId,
      caseId: body.caseId,
      op: body.op,
      payload: body.payload as object,
      summary: body.summary,
      diff: body.diff ?? null,
    })
    .onConflictDoUpdate({
      target: [aiStageCaseOps.threadId, aiStageCaseOps.localId],
      set: {
        caseId: body.caseId,
        op: body.op,
        payload: body.payload as object,
        summary: body.summary,
        diff: body.diff ?? null,
      },
    });
}

export function buildCaseOpsTools(ctx: SpaceToolsContext): ToolExecutor[] {
  return [
    {
      name: 'stage_case_op',
      description:
        '对已有用例/步骤发起修改请求，先暂存到当前线程的草稿区，用户在右侧 StagePanel 勾选 → 落库。7 个 action：update_case / delete_case / move_case / update_step / insert_step / delete_step / move_step。详见 promptGuidelines。',
      parameters: Type.Object({
        localId: Type.String({ minLength: 1, maxLength: 64 }),
        action: Type.Union([
          Type.Literal('update_case'),
          Type.Literal('delete_case'),
          Type.Literal('move_case'),
          Type.Literal('update_step'),
          Type.Literal('insert_step'),
          Type.Literal('delete_step'),
          Type.Literal('move_step'),
        ]),
        caseId: Type.Optional(Type.String()),
        targetGroupId: Type.Optional(Type.String()),
        patch: Type.Optional(Type.Object({
          title: Type.Optional(Type.String()),
          description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          priority: Type.Optional(Type.Union([Type.Literal('P0'), Type.Literal('P1'), Type.Literal('P2'), Type.Literal('P3')])),
          status: Type.Optional(Type.Union([Type.Literal('draft'), Type.Literal('review'), Type.Literal('ready'), Type.Literal('deprecated')])),
          url: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          expectedOutcome: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          defaultEnvId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          datasetId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        })),
        stepId: Type.Optional(Type.String()),
        stepIds: Type.Optional(Type.Array(Type.String())),
        instruction: Type.Optional(Type.String()),
        afterOrder: Type.Optional(Type.Number()),
        compiled: Type.Optional(Type.Array(Type.Unknown())),
      }),
      promptGuidelines: STAGE_CASE_OP_GUIDELINES,
      execute: async (input) => {
        const parsed = StageCaseOpInput.safeParse(input);
        if (!parsed.success) {
          return { ok: false, error: `参数不合法:${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}` };
        }
        const v = parsed.data;
        // 字段级必填校验（避免遗漏 id 后必填字段）
        if ((v.action === 'update_case' || v.action === 'delete_case' || v.action === 'move_case' || v.action === 'insert_step' || v.action === 'move_step') && !v.caseId) {
          return { ok: false, error: `${v.action} 需要 caseId` };
        }
        if ((v.action === 'update_step' || v.action === 'delete_step') && !v.stepId) {
          return { ok: false, error: `${v.action} 需要 stepId` };
        }
        if (v.action === 'update_case' && Object.keys(v.patch).length === 0) {
          return { ok: false, error: 'update_case 未提供任何要修改的字段' };
        }
        if (v.action === 'move_step' && v.stepIds.length === 0) {
          return { ok: false, error: 'move_step stepIds 不能为空' };
        }

        const before = await loadCaseOrThrow(ctx, v.caseId ?? '').catch((e) => {
          // 不抛错 —— 暂存是为了用户预览，落库时再校验归属
          if (e instanceof HttpError && (e.code === 'not_found' || e.code === 'cross_project_move')) return null;
          throw e;
        });
        if (!before && (v.action !== 'update_step' && v.action !== 'delete_step')) {
          return { ok: false, error: `case ${v.caseId} 不存在或不属于当前版本` };
        }
        if (v.action === 'update_step' || v.action === 'delete_step') {
          const step = before?.steps.find((s) => s.id === v.stepId);
          if (!step) return { ok: false, error: `step ${v.stepId} 不属于 case ${v.caseId}` };
        }

        const { summary, diff } = summaryFor(v, before);
        const doc: StagedCaseOpDoc & { caseId: string; op: string; payload: unknown } = {
          localId: (input as { localId?: string }).localId ?? genLocalId(),
          caseId: v.caseId ?? '',
          op: v.action,
          payload: v,
          summary,
          diff,
          stagedAt: new Date().toISOString(),
        };
        await stageCaseOp(ctx.threadId, ctx.versionId, doc);
        emitStage(ctx, {
          kind: 'case_op' as StageKind,
          id: doc.localId,
          action: 'stage',
          payload: doc,
        });
        const varNote = (v.action === 'insert_step' || v.action === 'update_step')
          ? await prospectiveVarNote(before, v).catch(() => '')
          : '';
        return { ok: true, data: `已暂存修改「${summary}」(草稿 ${doc.localId})；用户在 StagePanel 勾选 → 落库。${varNote ? `\n${varNote}` : ''}` };
      },
    },
  ];
}

/** 给 stageRoute.s / 落库时复用：按 ai_stage_case_ops 行执行真实写。op 与 buildCaseOpsTools 一一对应。 */
export async function applyCaseOp(op: string, payload: unknown, ctx: SpaceToolsContext): Promise<void> {
  const v = StageCaseOpInput.parse(payload);
  const caseId = v.caseId;
  // 二次校验：落库前再确认归属（与创建时一致）
  const before = await loadCaseOrThrow(ctx, caseId);
  switch (v.action) {
    case 'update_case':
      await svc.updateCase(caseId, v.patch as svc.UpdateCasePatch);
      return;
    case 'delete_case':
      await svc.deleteCase(caseId);
      return;
    case 'move_case': {
      const targetPid = await svc.groupProjectId(v.targetGroupId);
      if (!targetPid) throw new HttpError(404, 'not_found', `group ${v.targetGroupId} 不存在`);
      if (targetPid !== ctx.projectId) throw new HttpError(400, 'cross_project', '目标分组不属于当前项目');
      await svc.updateCase(caseId, { groupId: v.targetGroupId });
      return;
    }
    case 'update_step': {
      const step = before.steps.find((s) => s.id === v.stepId);
      if (!step) throw new HttpError(404, 'not_found', `step ${v.stepId} not in case ${caseId}`);
      await svc.updateCaseStep(v.stepId, {
        instruction: v.instruction,
        compiled: v.compiled === undefined ? undefined : (v.compiled as unknown[] | null),
      });
      return;
    }
    case 'insert_step':
      await svc.insertCaseStep(caseId, {
        instruction: v.instruction,
        afterOrder: v.afterOrder,
        compiled: v.compiled === undefined ? undefined : (v.compiled as unknown[] | null),
        source: 'agent',
      });
      return;
    case 'delete_step': {
      const step = before.steps.find((s) => s.id === v.stepId);
      if (!step) throw new HttpError(404, 'not_found', `step ${v.stepId} not in case ${caseId}`);
      // 单 case 内步骤操作包 transaction：删 + 后续 order 紧凑化（routes/steps.ts:151-153 写法）
      await db.transaction(async (tx) => {
        await tx.delete(testSteps).where(eq(testSteps.id, v.stepId));
        const remaining = await tx
          .select({ id: testSteps.id })
          .from(testSteps)
          .where(eq(testSteps.caseId, caseId))
          .orderBy(asc(testSteps.order));
        for (let i = 0; i < remaining.length; i++) {
          await tx.update(testSteps).set({ order: i + 1 }).where(eq(testSteps.id, remaining[i]!.id));
        }
      });
      return;
    }
    case 'move_step': {
      // 全列重排为 1..n；stepIds 必须覆盖全部步骤（routes/steps.ts:117-130 写法）
      const all = await db.select({ id: testSteps.id }).from(testSteps).where(eq(testSteps.caseId, caseId)).orderBy(asc(testSteps.order));
      const incoming = new Set(v.stepIds);
      if (all.length !== v.stepIds.length || !all.every((r) => incoming.has(r.id))) {
        throw new HttpError(400, 'invalid_order', 'move_step stepIds 必须恰好覆盖该 case 全部步骤');
      }
      await db.transaction(async (tx) => {
        for (let i = 0; i < v.stepIds.length; i++) {
          await tx.update(testSteps).set({ order: i + 1 }).where(eq(testSteps.id, v.stepIds[i]!));
        }
      });
      return;
    }
  }
  throw new HttpError(500, 'invariant', `unknown op ${op}`);
}