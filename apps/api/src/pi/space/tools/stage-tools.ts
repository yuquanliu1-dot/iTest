/**
 * 版本空间助手「暂存」服务 + 工具集：
 *   - 服务：listStage / stageCase / stageScenario / stageEnvironment / stagePlan / deleteStaged
 *   - 工具：stage_case / stage_scenario / stage_environment / stage_plan (供 LLM 走预览流)
 *
 * 与 ai_workspace_*（requirementId-keyed）不共享；这里按 (threadId, localId) 复合主键，
 * 落到 ai_stage_* 表。前端 StagePanel 勾选 → /stage/save 一次性落正式表。
 */
import { and, eq, inArray } from 'drizzle-orm';
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { db } from '../../../db/client.js';
import {
  aiStageCases, aiStageEnvironments, aiStagePlans, aiStageScenarios,
} from '../../../db/schema.js';
import { HttpError } from '../../../middleware/errorHandler.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';
import { emitStage } from './stage.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types (与前端 StageDoc 镜像)
// ─────────────────────────────────────────────────────────────────────────────

export type StageKind = 'case' | 'scenario' | 'environment' | 'plan';
export const STAGE_KINDS: StageKind[] = ['case', 'scenario', 'environment', 'plan'];

export interface StagedCase {
  localId: string;
  title: string;
  description?: string | null;
  priority?: string | null;
  url?: string | null;
  steps: unknown[];
  defaultEnvId?: string | null;
  expectedOutcome?: string | null;
}
export interface StagedScenario {
  localId: string;
  requirementId: string;
  title: string;
  description?: string | null;
  caseLocalIds: string[];
}
export interface StagedEnvironment {
  localId: string;
  name: string;
  baseUrl?: string | null;
  objects: Array<{ objectType: 'db' | 'syslog' | 'login'; label?: string; payload: Record<string, unknown>; isDefault?: boolean }>;
}
export interface StagedPlan {
  localId: string;
  name: string;
  environmentId?: string | null;
  caseLocalIds: string[];
}
export interface StageDoc {
  cases: Array<StagedCase & { stagedAt: string }>;
  scenarios: Array<StagedScenario & { stagedAt: string }>;
  environments: Array<StagedEnvironment & { stagedAt: string }>;
  plans: Array<StagedPlan & { stagedAt: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service: read / write / delete
// ─────────────────────────────────────────────────────────────────────────────

function asStagedCase(row: typeof aiStageCases.$inferSelect): StagedCase & { stagedAt: string } {
  return {
    localId: row.localId,
    title: row.title,
    description: row.description,
    priority: row.priority,
    url: row.url,
    steps: (row.steps ?? []) as unknown[],
    defaultEnvId: row.defaultEnvId,
    expectedOutcome: row.expectedOutcome,
    stagedAt: row.stagedAt.toISOString(),
  };
}
function asStagedScenario(row: typeof aiStageScenarios.$inferSelect): StagedScenario & { stagedAt: string } {
  return {
    localId: row.localId,
    requirementId: row.requirementId,
    title: row.title,
    description: row.description,
    caseLocalIds: row.caseLocalIds ?? [],
    stagedAt: row.stagedAt.toISOString(),
  };
}
function asStagedEnvironment(row: typeof aiStageEnvironments.$inferSelect): StagedEnvironment & { stagedAt: string } {
  return {
    localId: row.localId,
    name: row.name,
    baseUrl: row.baseUrl,
    objects: (row.objects ?? []) as StagedEnvironment['objects'],
    stagedAt: row.stagedAt.toISOString(),
  };
}
function asStagedPlan(row: typeof aiStagePlans.$inferSelect): StagedPlan & { stagedAt: string } {
  return {
    localId: row.localId,
    name: row.name,
    environmentId: row.environmentId,
    caseLocalIds: row.caseLocalIds ?? [],
    stagedAt: row.stagedAt.toISOString(),
  };
}

export async function listStage(threadId: string): Promise<StageDoc> {
  const [cRows, sRows, eRows, pRows] = await Promise.all([
    db.select().from(aiStageCases).where(eq(aiStageCases.threadId, threadId)),
    db.select().from(aiStageScenarios).where(eq(aiStageScenarios.threadId, threadId)),
    db.select().from(aiStageEnvironments).where(eq(aiStageEnvironments.threadId, threadId)),
    db.select().from(aiStagePlans).where(eq(aiStagePlans.threadId, threadId)),
  ]);
  return {
    cases: cRows.map(asStagedCase),
    scenarios: sRows.map(asStagedScenario),
    environments: eRows.map(asStagedEnvironment),
    plans: pRows.map(asStagedPlan),
  };
}

/** 按 (kind, localId) 删一批；空数组 = no-op。返回被删行数（用于去重清理场景的孤儿占位）。 */
export async function deleteStaged(
  threadId: string,
  kinds: StageKind[],
  localIds: string[],
): Promise<number> {
  if (localIds.length === 0) return 0;
  let removed = 0;
  if (kinds.includes('case')) {
    const r = await db.delete(aiStageCases)
      .where(and(eq(aiStageCases.threadId, threadId), inArray(aiStageCases.localId, localIds)))
      .returning({ localId: aiStageCases.localId });
    removed += r.length;
  }
  if (kinds.includes('scenario')) {
    const r = await db.delete(aiStageScenarios)
      .where(and(eq(aiStageScenarios.threadId, threadId), inArray(aiStageScenarios.localId, localIds)))
      .returning({ localId: aiStageScenarios.localId });
    removed += r.length;
  }
  if (kinds.includes('environment')) {
    const r = await db.delete(aiStageEnvironments)
      .where(and(eq(aiStageEnvironments.threadId, threadId), inArray(aiStageEnvironments.localId, localIds)))
      .returning({ localId: aiStageEnvironments.localId });
    removed += r.length;
  }
  if (kinds.includes('plan')) {
    const r = await db.delete(aiStagePlans)
      .where(and(eq(aiStagePlans.threadId, threadId), inArray(aiStagePlans.localId, localIds)))
      .returning({ localId: aiStagePlans.localId });
    removed += r.length;
  }
  return removed;
}

export async function stageCase(threadId: string, versionId: string, body: StagedCase): Promise<void> {
  if (!body.localId || !body.title) throw new HttpError(400, 'bad_request', 'localId 与 title 必填');
  await db
    .insert(aiStageCases)
    .values({
      threadId,
      localId: body.localId,
      versionId,
      title: body.title,
      description: body.description,
      priority: body.priority ?? null,
      url: body.url ?? null,
      steps: body.steps as object,
      defaultEnvId: body.defaultEnvId ?? null,
      expectedOutcome: body.expectedOutcome ?? null,
    })
    .onConflictDoUpdate({
      target: [aiStageCases.threadId, aiStageCases.localId],
      set: {
        title: body.title,
        description: body.description,
        priority: body.priority ?? null,
        url: body.url ?? null,
        steps: body.steps as object,
        defaultEnvId: body.defaultEnvId ?? null,
        expectedOutcome: body.expectedOutcome ?? null,
      },
    });
}

export async function stageScenario(threadId: string, versionId: string, body: StagedScenario): Promise<void> {
  if (!body.localId || !body.title || !body.requirementId) {
    throw new HttpError(400, 'bad_request', 'localId / title / requirementId 必填');
  }
  await db
    .insert(aiStageScenarios)
    .values({
      threadId,
      localId: body.localId,
      versionId,
      requirementId: body.requirementId,
      title: body.title,
      description: body.description,
      caseLocalIds: body.caseLocalIds,
    })
    .onConflictDoUpdate({
      target: [aiStageScenarios.threadId, aiStageScenarios.localId],
      set: {
        title: body.title,
        description: body.description,
        caseLocalIds: body.caseLocalIds,
      },
    });
}

export async function stageEnvironment(threadId: string, versionId: string, body: StagedEnvironment): Promise<void> {
  if (!body.localId || !body.name) throw new HttpError(400, 'bad_request', 'localId 与 name 必填');
  await db
    .insert(aiStageEnvironments)
    .values({
      threadId,
      localId: body.localId,
      versionId,
      name: body.name,
      baseUrl: body.baseUrl,
      objects: body.objects as object,
    })
    .onConflictDoUpdate({
      target: [aiStageEnvironments.threadId, aiStageEnvironments.localId],
      set: {
        name: body.name,
        baseUrl: body.baseUrl,
        objects: body.objects as object,
      },
    });
}

export async function stagePlan(threadId: string, versionId: string, body: StagedPlan): Promise<void> {
  if (!body.localId || !body.name) throw new HttpError(400, 'bad_request', 'localId 与 name 必填');
  await db
    .insert(aiStagePlans)
    .values({
      threadId,
      localId: body.localId,
      versionId,
      name: body.name,
      environmentId: body.environmentId,
      caseLocalIds: body.caseLocalIds,
    })
    .onConflictDoUpdate({
      target: [aiStagePlans.threadId, aiStagePlans.localId],
      set: {
        name: body.name,
        environmentId: body.environmentId,
        caseLocalIds: body.caseLocalIds,
      },
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tools: stage_case / stage_scenario / stage_environment / stage_plan
// LLM 走这些工具把对象写进暂存表；用户在 StagePanel 勾选 → /stage/save 落正式表。
// 与 manage_*（实时写）并列存在；调用方可在 prompt 里优先选 stage_*。
// ─────────────────────────────────────────────────────────────────────────────

const StepInput = z.object({
  action: z.string().min(1).max(2000),
  assertion: z.string().max(2000).nullable().optional(),
  compiled: z.array(z.unknown()).optional(),
});
const StageCaseInput = z.object({
  localId: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  description: z.string().max(4000).nullable().optional(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
  url: z.string().max(2000).nullable().optional(),
  steps: z.array(StepInput).max(30).optional(),
  defaultEnvId: z.string().uuid().nullable().optional(),
  expectedOutcome: z.string().max(4000).nullable().optional(),
});
const StageScenarioInput = z.object({
  localId: z.string().min(1).max(64),
  requirementId: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().max(4000).nullable().optional(),
  caseLocalIds: z.array(z.string().min(1).max(64)).max(50).optional(),
});
const StageEnvironmentInput = z.object({
  localId: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  baseUrl: z.string().max(2000).nullable().optional(),
  objects: z.array(z.object({
    objectType: z.enum(['db', 'syslog', 'login']),
    label: z.string().max(120).optional(),
    payload: z.record(z.unknown()),
    isDefault: z.boolean().optional(),
  })).max(10).optional(),
});
const StagePlanInput = z.object({
  localId: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  environmentId: z.string().uuid().nullable().optional(),
  caseLocalIds: z.array(z.string().min(1).max(64)).max(200).optional(),
});

export const STAGE_PROMPT_GUIDELINES = [
  '需要创建用例/场景/环境/计划时,优先调用 stage_case / stage_scenario / stage_environment / stage_plan ——对象先暂存在草稿区,用户在右侧 StagePanel 勾选并选目标分组后才会正式落库。',
  'localId 由你（LLM）用 UUID v4 自生成（如 crypto.randomUUID()）,相同 localId 重复 stage 是幂等 UPSERT,可放心重发。',
  '不要直接用 manage_cases / manage_environments / manage_plans 的 create/upsert ——那些是实时写,会跳过用户的预览选择阶段。',
];

export function buildStageTools(ctx: SpaceToolsContext): ToolExecutor[] {
  return [
    {
      name: 'stage_case',
      description: '暂存一个用例到当前线程的草稿区。localId 必须由调用方生成 UUID v4。steps[].action 是人类可读指令。',
      parameters: Type.Object({
        localId: Type.String({ minLength: 1, maxLength: 64 }),
        title: Type.String({ minLength: 1, maxLength: 200 }),
        description: Type.Optional(Type.Union([Type.String({ maxLength: 4000 }), Type.Null()])),
        priority: Type.Optional(Type.Union([Type.Literal('P0'), Type.Literal('P1'), Type.Literal('P2'), Type.Literal('P3')])),
        url: Type.Optional(Type.Union([Type.String({ maxLength: 2000 }), Type.Null()])),
        steps: Type.Optional(Type.Array(Type.Object({
          action: Type.String({ minLength: 1, maxLength: 2000 }),
          assertion: Type.Optional(Type.Union([Type.String({ maxLength: 2000 }), Type.Null()])),
          compiled: Type.Optional(Type.Array(Type.Unknown())),
        }), { maxItems: 30 })),
        defaultEnvId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        expectedOutcome: Type.Optional(Type.Union([Type.String({ maxLength: 4000 }), Type.Null()])),
      }),
      promptGuidelines: STAGE_PROMPT_GUIDELINES,
      execute: async (input) => {
        const v = StageCaseInput.safeParse(input);
        if (!v.success) return { ok: false, error: `参数不合法:${v.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
        await stageCase(ctx.threadId, ctx.versionId, {
          ...v.data,
          steps: v.data.steps ?? [],
        });
        emitStage(ctx, { kind: 'case', id: v.data.localId, action: 'stage' });
        return { ok: true, data: `已暂存用例「${v.data.title}」(草稿 ${v.data.localId});用户将在右侧预览区勾选 → 选目标分组 → 落库。` };
      },
    },
    {
      name: 'stage_scenario',
      description: '暂存一个场景到当前线程的草稿区。requirementId 来自上下文摘要或 stage_scenario 之前的 list。',
      parameters: Type.Object({
        localId: Type.String({ minLength: 1, maxLength: 64 }),
        requirementId: Type.String(),
        title: Type.String({ minLength: 1, maxLength: 200 }),
        description: Type.Optional(Type.Union([Type.String({ maxLength: 4000 }), Type.Null()])),
        caseLocalIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 50 })),
      }),
      promptGuidelines: STAGE_PROMPT_GUIDELINES,
      execute: async (input) => {
        const v = StageScenarioInput.safeParse(input);
        if (!v.success) return { ok: false, error: `参数不合法:${v.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
        await stageScenario(ctx.threadId, ctx.versionId, { ...v.data, caseLocalIds: v.data.caseLocalIds ?? [] });
        emitStage(ctx, { kind: 'scenario', id: v.data.localId, action: 'stage' });
        return { ok: true, data: `已暂存场景「${v.data.title}」` };
      },
    },
    {
      name: 'stage_environment',
      description: '暂存一个测试环境到当前线程的草稿区。payload 禁带 password/privateKey（凭据走 set_secret）。',
      parameters: Type.Object({
        localId: Type.String({ minLength: 1, maxLength: 64 }),
        name: Type.String({ minLength: 1, maxLength: 120 }),
        baseUrl: Type.Optional(Type.Union([Type.String({ maxLength: 2000 }), Type.Null()])),
        objects: Type.Optional(Type.Array(Type.Object({
          objectType: Type.Union([Type.Literal('db'), Type.Literal('syslog'), Type.Literal('login')]),
          label: Type.Optional(Type.String({ maxLength: 120 })),
          payload: Type.Record(Type.String(), Type.Unknown()),
          isDefault: Type.Optional(Type.Boolean()),
        }), { maxItems: 10 })),
      }),
      promptGuidelines: STAGE_PROMPT_GUIDELINES,
      execute: async (input) => {
        const v = StageEnvironmentInput.safeParse(input);
        if (!v.success) return { ok: false, error: `参数不合法:${v.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
        await stageEnvironment(ctx.threadId, ctx.versionId, {
          ...v.data,
          objects: v.data.objects ?? [],
        });
        emitStage(ctx, { kind: 'environment', id: v.data.localId, action: 'stage' });
        return { ok: true, data: `已暂存环境「${v.data.name}」` };
      },
    },
    {
      name: 'stage_plan',
      description: '暂存一个执行计划到当前线程的草稿区。caseLocalIds 是 stage_case 时已声明的 localId。',
      parameters: Type.Object({
        localId: Type.String({ minLength: 1, maxLength: 64 }),
        name: Type.String({ minLength: 1, maxLength: 200 }),
        environmentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        caseLocalIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 200 })),
      }),
      promptGuidelines: STAGE_PROMPT_GUIDELINES,
      execute: async (input) => {
        const v = StagePlanInput.safeParse(input);
        if (!v.success) return { ok: false, error: `参数不合法:${v.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
        await stagePlan(ctx.threadId, ctx.versionId, { ...v.data, caseLocalIds: v.data.caseLocalIds ?? [] });
        emitStage(ctx, { kind: 'plan', id: v.data.localId, action: 'stage' });
        return { ok: true, data: `已暂存计划「${v.data.name}」` };
      },
    },
  ];
}
