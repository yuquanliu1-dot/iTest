/**
 * stage_case_op: all modifications of "existing cases/steps" go uniformly through staging → StagePanel check-off → persistence.
 * Replaces manage_cases.update/delete/move_group's real-time persistence + ConfirmCard; cleanup in the same direction as the old aiStep/solveCaptcha kinds.
 *
 * One tool, many actions (consistent with the manage_cases.action field precedent; saves one tool schema across rounds):
 *   - update_case   {caseId, patch: UpdateCasePatch}     → svc.updateCase
 *   - delete_case   {caseId}                            → svc.deleteCase (executed at persistence time; the user has checked it in StagePanel)
 *   - move_case     {caseId, targetGroupId}              → svc.updateCase({groupId})
 *   - update_step   {stepId, instruction?, compiled?}    → svc.updateCaseStep
 *   - insert_step   {caseId, instruction, afterOrder?, compiled?} → svc.insertCaseStep
 *   - delete_step   {stepId}                            → delete + compact the order of subsequent steps
 *   - move_step     {caseId, stepIds}                   → reorder to 1..n (per routes/steps.ts:117-130)
 *
 * compiled defensive validation reuses normalizeCompiledStep (pi/tools.ts) + z.array(StepAction).min(1).
 * Ownership: detail.versionId === ctx.versionId.
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
import { buildOutcomeNote } from './outcomeNote.js';
import { HttpError } from '../../../middleware/errorHandler.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';
import { emitStage } from './stage.js';
import { diffText } from './diff.js';
import { st, type StLang } from '../../../i18n.js';
import { aiLangFrom } from '../../../agent/langDirective.js';
import type { StageKind } from './stage-tools.js';
export type { SpaceToolsContext } from './context.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types + zod validation
// ─────────────────────────────────────────────────────────────────────────────

const StepActionShape = z.object({
  kind: z.string().min(1),
}).passthrough();

const CompiledNullableArray = z
  .preprocess((v) => {
    if (v === null) return null;
    if (!Array.isArray(v)) return v;
    if (v.length === 0) return null; // empty array == give up
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
  /** Dataset row selection: array of enabled-row indexes (0-based, renumbered after disabled rows are removed). [] = all enabled rows. */
  datasetRowIndexes: z.array(z.number().int().min(0)).max(500).nullable().optional(),
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
// Tool set: staging → aiStageCaseOps table + broadcast the stage event
// ─────────────────────────────────────────────────────────────────────────────

export const STAGE_CASE_OP_GUIDELINES = [
  '修改已有用例（更新元数据 / 删除 / 移动分组）或编辑已有用例的步骤（重编译 / 改 instruction / 插入 / 删除 / 排序）时，统一调用 stage_case_op；用户在右侧 StagePanel 勾选确认后才落库。',
  '不要直接调用 manage_cases 的 update/delete/move_group —— 那些场景已下线。manage_cases 只剩 search/get/create_group。',
  '不要用 stage_case / manage_cases.create 修改已有用例 —— stage_case 是创建全新用例的，请用 action=update_case/move_case。',
  '在生成 compiled 前，先调用 manage_cases get 拿 caseId/versionId/expectedOutcome/steps 全量；locator 证据优先用 verify_case 失败反馈的 failure.page.elements（运行时真实元素），证据不足时自主调 inspect_page 补抓页面（locator 的 testId/aria-label/css 必须取自真实元素清单，禁止凭"典型实现"臆造）。',
  'compiled 是 JSON 数组（元素形如 {kind, ...}），允许 kind：navigate / click / fill / hover / waitFor / assertText / assertVisible / check / select / extract / aiTask（动态验证码/弹窗等用 aiTask，不要用普通 fill）/ httpRequest {method, url, headers[], body?, timeoutMs?, carryLoginState?, saveAs?, assertion?}（REST API 请求步骤：saveAs 提取响应值为 {{var}} 供后续步骤消费,carryLoginState 转发浏览器登录态；url/headers 值/body 支持 {{变量}}）。禁止输出 aiStep。',
  'case.url 只存相对路径(如 /admin/login),执行时由环境 web 服务拼接;update_case 的 patch.url 传相对;patch.webServiceRef 可指定环境内 web 服务标识(缺省用默认)。',
  '若判断无法可靠编译（指令过于模糊），把 compiled 设为 null 表示「已放弃」。空数组也会被映射为 null（回放里等价于「什么都不做」会隐藏失败）。',
  'stage_case_op 的 action 与字段一一对应：update_case {caseId, patch={...UpdateCasePatch 形状字段}}、delete_case {caseId}、move_case {caseId, targetGroupId}、update_step {stepId, caseId, instruction?, compiled?}、insert_step {caseId, instruction, afterOrder?, compiled?}、delete_step {stepId, caseId}、move_step {caseId, stepIds}。move_step 的 stepIds 必须恰好覆盖该 case 全部步骤并按目标顺序排列。',
  'localId 由你（LLM）用 UUID v4 自生成；同 localId 重复 stage 是幂等 UPSERT，可放心重发。',
  '用例绑定/解绑数据集走 update_case(patch.datasetId)（跨项目数据集会被拒绝）；数据集列名即回放初始变量 {{列名}}，insert_step/update_step 响应会附「变量体检」反馈，引用未定义变量时请修正 compiled 或先确认数据集列名（manage_datasets list / get）。',
  '用例只跑数据集的部分行：update_case(patch.datasetRowIndexes=[下标,...])。下标是「启用行下标」（0 基，剔除禁用行后重新编号，与 manage_cases get 回带的 dataset.rowIndexes 同一空间）；[] = 所有启用行（默认）。换数据集或解绑会清空选择。注意 manage_datasets get 只回前 10 行，因此 AI 只能可靠地选择可见范围内的行；行数更多时宁可省略该字段（=所有行）也不猜下标。',
  '登录步骤的凭据不要写明文：用户名输入框 fill 的 value 写字面量 __ITEST_USERNAME__、密码输入框写字面量 __ITEST_PASSWORD__，回放与 AI 相（verify_case/solidify_case）都会自动替换为环境默认 web 服务配置的登录凭据；环境未配置则该步报 env-missing 失败。除这两个字面量外不要臆造别的 __ITEST_xxx__。',
  '改 expectedOutcome 前先分清本用例是「观察型」还是「变更型」:观察型(进页面查看列表状态)只配「页面可达/数据可见」断言,把 expectedOutcome 改成业务结果(如"自动启动处置成功")会让 verify_case 终态判定必然失败,而你唯一的过关手段就成了弱化预期——把用例改成什么都测不出来。响应里的「预期体检」点名了这种不自洽,修正步骤(补造数步骤)或如实改预期,两者都要真改。',
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

function summaryFor(input: StageCaseOpInput, before: Awaited<ReturnType<typeof svc.getCaseDetail>>, lang: StLang): { summary: string; diff?: string } {
  const title = before?.title ?? '用例';
  switch (input.action) {
    case 'update_case': {
      const keys = Object.keys(input.patch);
      const summary = st(lang, 'case.updated', { title, keys: keys.join('/') });
      const after = { ...before, ...input.patch };
      return { summary, diff: diffText(before ?? {}, after as Record<string, unknown>) };
    }
    case 'delete_case':
      return { summary: st(lang, 'case.deleted', { title }) };
    case 'move_case':
      return { summary: st(lang, 'case.moved', { title, target: input.targetGroupId }), diff: `groupId: ${before?.groupId ?? '?'} → ${input.targetGroupId}` };
    case 'update_step': {
      const step = before?.steps.find((s) => s.id === input.stepId);
      const order = step?.order ?? '?';
      const willChange: string[] = [];
      if (input.instruction !== undefined) willChange.push('instruction');
      if (input.compiled !== undefined) willChange.push('compiled');
      const summary = st(lang, 'step.updated', { order, changes: willChange.join('+') || 'noop' });
      const afterStep = { ...step, instruction: input.instruction ?? step?.instruction, compiled: input.compiled ?? step?.compiled };
      const diff = diffText({ instruction: step?.instruction, compiled: step?.compiled }, { instruction: afterStep?.instruction, compiled: afterStep?.compiled });
      return { summary, diff };
    }
    case 'insert_step':
      return {
        summary: input.afterOrder !== undefined
          ? st(lang, 'step.insertAfter', { order: input.afterOrder })
          : st(lang, 'step.insertEnd'),
      };
    case 'delete_step': {
      const step = before?.steps.find((s) => s.id === input.stepId);
      return { summary: st(lang, 'step.deleted', { order: step?.order ?? '?' }) };
    }
    case 'move_step':
      return { summary: st(lang, 'step.reordered', { count: input.stepIds.length }) };
  }
}

/** Prospective variable check for step-write ops: computed over the full compiled actions after virtually applying the op (including bound dataset columns as initial variables),
 *  appended as text to the staging response so the AI can self-check — errors in a written {{var}} surface immediately, not at replay time. */
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
    // Aligned with the real insertCaseStep: insert after afterOrder; out of range (>= maxOrder) lands at the tail, not the head.
    const ord = v.afterOrder;
    const at = ord !== undefined ? steps.filter((s) => s.order <= ord).length : steps.length;
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

/** expectedOutcome self-consistency check: when update_case changes the expectation, judge from the case's existing steps whether
 *  "the asserted business state can actually be produced" (advisory only, never a hard kill; same source as stage_case). One tool,
 *  one action, and this op contains no step changes, so the pre-persistence steps suffice — no virtual overlay needed. */
function outcomeNoteAfterOp(
  before: Awaited<ReturnType<typeof svc.getCaseDetail>> | null,
  v: Extract<StageCaseOpInput, { action: 'update_case' }>,
): string | null {
  const expectedOutcome = v.patch.expectedOutcome;
  if (expectedOutcome === undefined || !before) return null;
  return buildOutcomeNote({
    expectedOutcome,
    stepActions: before.steps.map((s) => s.instruction),
    stepCompileds: before.steps.map((s) => s.compiled),
  });
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
          datasetRowIndexes: Type.Optional(Type.Array(Type.Number())),
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
        // Field-level required validation (catches required fields that slip through when an id is missing)
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
          // Don't throw — staging exists for user preview; ownership is validated again at persistence time
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

        const { summary, diff } = summaryFor(v, before, aiLangFrom(ctx.lang));
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
        const outNote = v.action === 'update_case' ? outcomeNoteAfterOp(before, v) : null;
        const notes = [varNote, outNote].filter(Boolean).join('\n');
        return { ok: true, data: `已暂存修改「${summary}」(草稿 ${doc.localId})；用户在 StagePanel 勾选 → 落库。${notes ? `\n${notes}` : ''}` };
      },
    },
  ];
}

/** Reused by stageRoute.s / at persistence time: performs the real write for an ai_stage_case_ops row. Ops correspond one-to-one with buildCaseOpsTools. */
export async function applyCaseOp(op: string, payload: unknown, ctx: SpaceToolsContext): Promise<void> {
  // Invalid payload shape → a readable HttpError (not a bare ZodError: ZodError lands as 400 validation_failed
  // with no message in the body, so the frontend can only show "参数校验失败，请检查输入" — measured on prod228 2026-11-11).
  const parsed = StageCaseOpInput.safeParse(payload);
  if (!parsed.success) {
    throw new HttpError(400, 'staged_op_invalid', `暂存修改参数不合法：${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('；')}`);
  }
  const v = parsed.data;
  const caseId = v.caseId;
  // Second validation: re-confirm ownership right before persisting (consistent with creation)
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
      // Step ops within one case wrapped in a transaction: delete + compact subsequent order (routes/steps.ts:151-153 style)
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
      // Direct db writes bypass cases.service; the list cache (solidify-progress column) must be invalidated manually
      await svc.invalidateCasesCache(ctx.projectId);
      return;
    }
    case 'move_step': {
      // Reorder the whole list to 1..n; stepIds must cover all steps (routes/steps.ts:117-130 style)
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
      await svc.invalidateCasesCache(ctx.projectId);
      return;
    }
  }
  throw new HttpError(500, 'invariant', `unknown op ${op}`);
}

/** Pre-flight check before persistence: the checked ops first pass through "shape + reference existence" as a whole batch; only when all pass is writing allowed.
 *
 *  Why the pre-flight is mandatory (measured on prod228 2026-11-11): ops are applied one by one; when an invalid op sits in the middle of
 *  the batch, the earlier insert_step has already been persisted and the stage row isn't deleted (failure doesn't roll back) → the user
 *  retries → the same step is inserted repeatedly (3 duplicates observed). The pre-flight stops "guaranteed to fail" ops before the first write.
 *
 *  Read-only: the pre-flight only queries the DB and writes nothing. */
export async function preflightCaseOps(
  rows: Array<{ localId: string; op: string; payload: unknown; summary?: string | null }>,
  ctx: SpaceToolsContext,
): Promise<void> {
  const stepIdsByCase = new Map<string, Set<string>>();
  const loadStepIds = async (caseId: string): Promise<Set<string>> => {
    let ids = stepIdsByCase.get(caseId);
    if (!ids) {
      const detail = await svc.getCaseDetail(caseId);
      if (!detail) {
        throw new HttpError(404, 'not_found', `用例 ${caseId} 不存在或已被删除——请在暂存区取消相关修改后重试`);
      }
      if (detail.versionId !== ctx.versionId) {
        throw new HttpError(404, 'not_found', `用例 ${caseId} 不属于当前版本——请在暂存区取消相关修改后重试`);
      }
      ids = new Set(detail.steps.map((s) => s.id));
      stepIdsByCase.set(caseId, ids);
    }
    return ids;
  };

  for (const row of rows) {
    const parsed = StageCaseOpInput.safeParse(row.payload);
    if (!parsed.success) {
      throw new HttpError(400, 'staged_op_invalid', `暂存修改「${row.summary ?? row.localId}」参数不合法：${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('；')}`);
    }
    const v = parsed.data;
    if (v.action === 'update_step' || v.action === 'delete_step') {
      const ids = await loadStepIds(v.caseId);
      if (!ids.has(v.stepId)) {
        throw new HttpError(400, 'staged_op_invalid', `暂存修改「${row.summary ?? row.localId}」引用的步骤不存在（${v.stepId}）——它可能已被删除，或属于另一条还没保存的暂存插入。请在暂存区取消这条修改后重试。`);
      }
    }
    // move_step must cover exactly all steps (same judgment as applyCaseOp) — a non-covering set is guaranteed to fail mid-persistence,
    // and stopping it early avoids ops ahead of it in the same batch already having been written (the duplicated-insert class of dirty data).
    if (v.action === 'move_step') {
      const ids = await loadStepIds(v.caseId);
      const incoming = new Set(v.stepIds);
      if (ids.size !== v.stepIds.length || ![...ids].every((id) => incoming.has(id))) {
        throw new HttpError(400, 'staged_op_invalid', `暂存修改「${row.summary ?? row.localId}」的 move_step 必须恰好覆盖该用例全部步骤（当前 ${ids.size} 步）——请在暂存区取消这条修改后重试。`);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Virtual application (no persistence): overlay the staged caseOps onto the DB case, so verify_case can keep verifying from the staged state.
// Semantics aligned with applyCaseOp, but it only computes the effective steps / casePatch and writes nothing.
// ─────────────────────────────────────────────────────────────────────────────

/** "Effective steps" aligned with the testSteps row shape (virtually inserted steps carry no secret fields). */
export interface EffectiveStep {
  id: string;
  order: number;
  instruction: string | null;
  compiled: unknown;
  assertion: unknown;
  sensitive: boolean;
  delayMs: number | null;
  secretCiphertext: string | null;
  secretIv: string | null;
  secretTag: string | null;
}

export interface CaseOverlay {
  /** The execution-affecting part of the update_case patch (the remaining metadata is irrelevant to verification). */
  url?: string | null;
  defaultEnvId?: string | null;
  /** With step-level ops, the full overlaid steps; null otherwise means keep using the DB steps. */
  steps: EffectiveStep[] | null;
  /** delete_case staged: the case is pending deletion and should not be verified again. */
  deleteStaged: boolean;
  /** Number of ops successfully overlaid (including non-execution-affecting counts like move_case, shown in the UI). */
  opsApplied: number;
}

/** Synthetic-id prefix for steps in the overlay that are "staged-inserted but not yet persisted". Real step ids are uuids, so no collision. */
export const OVERLAY_STEP_PREFIX = 'staged:';

/** Synthetic id of an overlaid insert step = staged:<the insert op's localId>.
 *  localId rather than an array index: solidification needs to write the mechanical compiled back to that one insert stage row;
 *  an index drifts with "which ops got checked / their order" — localId is that row's stable identity. */
export function overlayStepId(insertLocalId: string | undefined, idx: number): string {
  return `${OVERLAY_STEP_PREFIX}${insertLocalId ?? idx}`;
}

/** Synthetic id → its insert op's localId; null when the id is not an overlaid step. */
export function overlayInsertLocalId(stepId: string): string | null {
  return stepId.startsWith(OVERLAY_STEP_PREFIX) ? stepId.slice(OVERLAY_STEP_PREFIX.length) : null;
}

export function computeCaseOverlay(
  dbSteps: EffectiveStep[],
  ops: Array<{ payload: unknown; localId?: string }>,
): CaseOverlay {
  const overlay: CaseOverlay = { steps: null, deleteStaged: false, opsApplied: 0 };
  let steps: EffectiveStep[] | null = null;
  const ensure = (): EffectiveStep[] => (steps ??= dbSteps.map((s) => ({ ...s })));
  const normalize = (): void => steps!.forEach((s, i) => { s.order = i + 1; });
  ops.forEach(({ payload, localId }, idx) => {
    const parsed = StageCaseOpInput.safeParse(payload);
    if (!parsed.success) return;
    const v = parsed.data;
    switch (v.action) {
      case 'update_case':
        if (v.patch.url !== undefined) overlay.url = v.patch.url;
        if (v.patch.defaultEnvId !== undefined) overlay.defaultEnvId = v.patch.defaultEnvId;
        overlay.opsApplied++;
        break;
      case 'delete_case':
        overlay.deleteStaged = true;
        overlay.opsApplied++;
        break;
      case 'update_step': {
        const st = ensure().find((s) => s.id === v.stepId);
        if (!st) break;
        if (v.instruction !== undefined) st.instruction = v.instruction;
        if (v.compiled !== undefined) st.compiled = v.compiled;
        normalize();
        overlay.steps = steps;
        overlay.opsApplied++;
        break;
      }
      case 'insert_step': {
        const list = ensure();
        const st: EffectiveStep = {
          id: overlayStepId(localId, idx),
          order: 0,
          instruction: v.instruction,
          compiled: v.compiled ?? null,
          assertion: null,
          sensitive: false,
          delayMs: null,
          secretCiphertext: null,
          secretIv: null,
          secretTag: null,
        };
        // Aligned with insertCaseStep: afterOrder is the persisted 0-based order value; the new step lands after the step
        // at "array index==afterOrder in the current list". After move/delete the list order == the current persisted DB order,
        // so afterOrder maps directly onto the list's 0-based array index, +1 places it after that step.
        // (insertCaseStep:targetOrder = afterOrder+1; steps with original order>=targetOrder shift later;
        //  the list's array index is the current 0-based order — equivalent.)
        const at = v.afterOrder !== undefined ? Math.min(v.afterOrder + 1, list.length) : list.length;
        list.splice(at, 0, st);
        normalize();
        overlay.steps = steps;
        overlay.opsApplied++;
        break;
      }
      case 'delete_step': {
        const list = ensure();
        const i = list.findIndex((s) => s.id === v.stepId);
        if (i < 0) break;
        list.splice(i, 1);
        normalize();
        overlay.steps = steps;
        overlay.opsApplied++;
        break;
      }
      case 'move_step': {
        const list = ensure();
        const byId = new Map(list.map((s) => [s.id, s]));
        if (!v.stepIds.every((id) => byId.has(id))) break;
        const rest = list.filter((s) => !v.stepIds.includes(s.id));
        steps = v.stepIds.map((id) => byId.get(id)!).concat(rest);
        normalize();
        overlay.steps = steps;
        overlay.opsApplied++;
        break;
      }
      case 'move_case':
        // Group moves don't affect execution; count only
        overlay.opsApplied++;
        break;
    }
  });
  return overlay;
}