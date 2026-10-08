/**
 * 版本空间助手「暂存」服务 + 工具集：
 *   - 服务：listStage / stageCase / stageScenario / stageEnvironment / stagePlan / stageDataset / deleteStaged
 *   - 工具：stage_case / stage_scenario / stage_environment / stage_plan / stage_dataset (供 LLM 走预览流)
 *
 * 与 ai_workspace_*（requirementId-keyed）不共享；这里按 (threadId, localId) 复合主键，
 * 落到 ai_stage_* 表。前端 StagePanel 勾选 → /stage/save 一次性落正式表。
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { validateVariableName, VAR_NAME_RE, type StepAction } from '@itest/shared';
import { db } from '../../../db/client.js';
import {
  aiStageCaseOps, aiStageCases, aiStageDatasets, aiStageEnvironments, aiStagePlans, aiStageScenarios,
} from '../../../db/schema.js';
import { HttpError } from '../../../middleware/errorHandler.js';
import { buildVariableReport } from '../../../lib/variable-report.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';
import { emitStage } from './stage.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types (与前端 StageDoc 镜像)
// ─────────────────────────────────────────────────────────────────────────────

export type StageKind = 'case' | 'case_op' | 'scenario' | 'environment' | 'plan' | 'dataset';
export const STAGE_KINDS: StageKind[] = ['case', 'case_op', 'scenario', 'environment', 'plan', 'dataset'];

export interface StagedCase {
  localId: string;
  title: string;
  description?: string | null;
  priority?: string | null;
  url?: string | null;
  steps: unknown[];
  defaultEnvId?: string | null;
  expectedOutcome?: string | null;
  /** 配套绑定：同批暂存数据集的 localId（save 时数据集先落库、真实 datasetId 回填到用例）。 */
  datasetLocalId?: string | null;
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
export interface StagedCaseOp {
  localId: string;
  caseId: string;
  op: 'update_case' | 'delete_case' | 'move_case' | 'update_step' | 'insert_step' | 'delete_step' | 'move_step';
  payload: unknown;
  summary: string;
  diff?: string;
}
/** 明文数据集草稿：AI 生成的列定义 + 行数据；敏感格仅在 /stage/save 落库时加密。 */
export interface StagedDataset {
  localId: string;
  name: string;
  description?: string | null;
  columns: Array<{ name: string; sensitive?: boolean }>;
  rows: Array<{ disabled?: boolean; cells: Record<string, string> }>;
}

export interface StageDoc {
  cases: Array<StagedCase & { stagedAt: string }>;
  scenarios: Array<StagedScenario & { stagedAt: string }>;
  environments: Array<StagedEnvironment & { stagedAt: string }>;
  plans: Array<StagedPlan & { stagedAt: string }>;
  caseOps: Array<StagedCaseOp & { stagedAt: string }>;
  datasets: Array<StagedDataset & { stagedAt: string }>;
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
    datasetLocalId: row.datasetLocalId,
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
function asStagedCaseOp(row: typeof aiStageCaseOps.$inferSelect): StagedCaseOp & { stagedAt: string } {
  return {
    localId: row.localId,
    caseId: row.caseId,
    op: row.op as StagedCaseOp['op'],
    payload: row.payload,
    summary: row.summary,
    diff: row.diff ?? undefined,
    stagedAt: row.stagedAt.toISOString(),
  };
}
function asStagedDataset(row: typeof aiStageDatasets.$inferSelect): StagedDataset & { stagedAt: string } {
  return {
    localId: row.localId,
    name: row.name,
    description: row.description,
    columns: (row.columns ?? []) as StagedDataset['columns'],
    rows: (row.rows ?? []) as StagedDataset['rows'],
    stagedAt: row.stagedAt.toISOString(),
  };
}

export async function listStage(threadId: string): Promise<StageDoc> {
  const [cRows, sRows, eRows, pRows, opRows, dsRows] = await Promise.all([
    db.select().from(aiStageCases).where(eq(aiStageCases.threadId, threadId)),
    db.select().from(aiStageScenarios).where(eq(aiStageScenarios.threadId, threadId)),
    db.select().from(aiStageEnvironments).where(eq(aiStageEnvironments.threadId, threadId)),
    db.select().from(aiStagePlans).where(eq(aiStagePlans.threadId, threadId)),
    db.select().from(aiStageCaseOps).where(eq(aiStageCaseOps.threadId, threadId)).orderBy(asc(aiStageCaseOps.stagedAt)),
    db.select().from(aiStageDatasets).where(eq(aiStageDatasets.threadId, threadId)),
  ]);
  return {
    cases: cRows.map(asStagedCase),
    scenarios: sRows.map(asStagedScenario),
    environments: eRows.map(asStagedEnvironment),
    plans: pRows.map(asStagedPlan),
    caseOps: opRows.map(asStagedCaseOp),
    datasets: dsRows.map(asStagedDataset),
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
  if (kinds.includes('case_op')) {
    const r = await db.delete(aiStageCaseOps)
      .where(and(eq(aiStageCaseOps.threadId, threadId), inArray(aiStageCaseOps.localId, localIds)))
      .returning({ localId: aiStageCaseOps.localId });
    removed += r.length;
  }
  if (kinds.includes('dataset')) {
    const r = await db.delete(aiStageDatasets)
      .where(and(eq(aiStageDatasets.threadId, threadId), inArray(aiStageDatasets.localId, localIds)))
      .returning({ localId: aiStageDatasets.localId });
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
      datasetLocalId: body.datasetLocalId ?? null,
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
        datasetLocalId: body.datasetLocalId ?? null,
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

/** 数据集草稿暂存：shape 校验在工具层（zod）做完；这里只保证必填 + upsert。
 *  rows 一律明文（含 sensitive 列）——加密发生在 /stage/save 的 createDataset。 */
export async function stageDataset(threadId: string, versionId: string, body: StagedDataset): Promise<void> {
  if (!body.localId || !body.name) throw new HttpError(400, 'bad_request', 'localId 与 name 必填');
  await db
    .insert(aiStageDatasets)
    .values({
      threadId,
      localId: body.localId,
      versionId,
      name: body.name,
      description: body.description ?? null,
      columns: body.columns as object,
      rows: body.rows as object,
    })
    .onConflictDoUpdate({
      target: [aiStageDatasets.threadId, aiStageDatasets.localId],
      set: {
        name: body.name,
        description: body.description ?? null,
        columns: body.columns as object,
        rows: body.rows as object,
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
  datasetLocalId: z.string().min(1).max(64).nullable().optional(),
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
/** 数据集草稿入参：staging 时做 shape 快速反馈（列名合法/去重、cells ⊆ 列集、值全 string）。
 *  上限与 datasets.service 对齐（列 30 / 行 500）；加密留给落库（createDataset）。 */
const StageDatasetInput = z.object({
  localId: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  description: z.string().max(4000).nullable().optional(),
  columns: z.array(z.object({
    name: z.string().min(1).max(64),
    sensitive: z.boolean().optional(),
  })).min(1).max(30),
  rows: z.array(z.object({
    disabled: z.boolean().optional(),
    cells: z.record(z.string()),
  })).max(500).optional(),
}).superRefine((v, ctx) => {
  const seen = new Set<string>();
  for (const c of v.columns) {
    const colName = c.name.trim();
    if (!validateVariableName(colName).ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['columns'], message: `列名 ${c.name} 不是合法变量名（字母/下划线开头，仅字母数字下划线）` });
      return;
    }
    if (seen.has(colName)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['columns'], message: `列名重复：${colName}` });
      return;
    }
    seen.add(colName);
  }
  (v.rows ?? []).forEach((row, i) => {
    for (const k of Object.keys(row.cells)) {
      if (!seen.has(k)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rows', i, 'cells'], message: `第 ${i + 1} 行存在未在 columns 声明的列：${k}` });
        return;
      }
    }
  });
});

export const STAGE_PROMPT_GUIDELINES = [
  '需要创建用例/场景/环境/计划时,优先调用 stage_case / stage_scenario / stage_environment / stage_plan ——对象先暂存在草稿区,用户在右侧 StagePanel 勾选并选目标分组后才会正式落库。',
  '修改已有用例(更新元数据/删除/移动分组)或编辑其步骤(重编译 / 改 instruction / 插入 / 删除 / 排序)统一走 stage_case_op —— 详见该工具 promptGuidelines。manage_cases 已下线 update/delete/move_group 写动作,只剩 search/get/create_group。',
  'localId 由你（LLM）用 UUID v4 自生成（如 crypto.randomUUID()）,相同 localId 重复 stage 是幂等 UPSERT,可放心重发。',
  '不要直接用 manage_cases 的 update/delete/move_group —— 那些 action 已下线,请改走 stage_case_op。',
  '数据驱动回放（同一流程跑多组数据）用 stage_dataset 生成数据集：列名即回放变量 {{列名}},行间差异（输入值/断言文案/预期提示）写成列值;配套的用例用 stage_case 的 datasetLocalId 绑定（同一批保存时数据集先落库并自动绑定）。用例步骤里 fill 的 value / 断言文案直接写 {{列名}}。',
  '步骤里的 {{变量名}} 必须与数据集列名逐字一致（列名只能字母/下划线开头,中文列名非法）——stage_case 响应附「变量体检」,引用未定义/不一致变量时请立即修正后重发。',
  '数据集敏感列（密码/密钥等）标 sensitive:true,单元格值仍以明文给出（落库时自动加密,预览对用户可见）;已有数据集的行值/敏感值对你永不可见（list_datasets 仅结构）。修改已有数据集暂不支持;给已有用例绑定已落库数据集走 stage_case_op update_case(patch.datasetId)。',
  'stage_case 的每条 step 必须输出 compiled 字段（DSL 步骤数组,回放直接执行,保存时不再编译）。规则：',
  '- compiled 是 JSON 数组,元素形如 {"kind": "...", ...}；允许 kind：navigate {url} / click {locator} / fill {locator, value} / hover {locator} / waitFor {locator, timeoutMs?} / assertText {locator, equals} / assertVisible {locator} / check {locator, checked} / select {locator, value} / extract {locator, varName} / aiTask {instruction}（运行时智能体执行,不预编译,原样保留）。禁止输出 aiStep。',
  '- locator 是 [{"strategy":"...","value":"..."}] 的一层数组,可给多个候选按序探测;strategy 只能是 "role" | "text" | "testId" | "css" | "xpath";role 的 value 形如 "textbox[name=\'用户名\']" 且必须小写。xpath 仅用于读取历史数据,新生成的步骤优先 css / role / text / testId,因为 xpath 的绝对路径在 SPA 重渲染时极易失效。表单字段优先用 css 属性选择器形式 [{strategy:"css", value:"[placeholder=\\"账号\\"]"}, {strategy:"css", value:"[name=\\"username\\"]"}, {strategy:"role", value:"textbox[name=\\"账号\\"]"}]。locator **只有一层数组**,每个元素直接是 {strategy,value} 对象,不要把每个候选再嵌一层数组。完整 step 示例：{kind:"click", locator:[{strategy:"css", value:"button[type=\'submit\']"}]}。禁止把 locator 写成对象（如 {item:{...}} 或 {strategy:"...",value:"..."} 直接放在 locator 槽），回放无法识别。',
  '- navigate 的 url 必须是绝对 URL,且必须使用上下文里的真实页面 URL（host:port/path 原样保留）,禁止臆造 http://localhost:5173/...。没拿到 URL 时,生成用例前先调用 inspect_page 抓取真实页面,从抓取结果里取真实 URL 与 locator,禁止凭「典型实现」编造 testid/id。',
  '- inspect_page 快照仅为页面初始状态:点击/提交后才出现的元素（结果区、错误提示）不在清单中。断言这类元素必须先触发对应操作再断言,或断言清单中其稳定的父容器;快照与动态都确认不了的元素用 role/text 定位。',
  '- case 的「初始化导航 URL」(stage_case 的 url 字段)回放开始时已由系统执行,steps 里不要再写一条 {kind:"navigate", url: case.url} —— 重复导航既慢又让 locator 校验/网络抓取做两遍。step 真的意图是跳到不同页面/子路由时才写 navigate(url=目标 URL);只是「到登录页开始操作」时,不要写 navigate,直接 fill/click 即可。',
  '- 末尾断言（强约束）:步骤执行后若有可观察结果,断言必须基于真实可见元素——优先 assertVisible（元素级,不依赖文案）;次之 assertText + locator + match:"contains"。禁止使用 target:"page" 的整页模糊自由文本断言（例「登录页正常加载」）,它对任何页面都命中,掩盖回放失败。navigate 步骤本身不要补断言。',
  '- 若 step 没有可观察结果（如「打开某页」）,不要补任何断言。',
  '- 若判断无法可靠编译（指令过于模糊、需视觉识别但无 #cssSelector 占位）,把 compiled 设为 null 表示「已放弃」。注意 null ≠ []:空数组在回放里等价于「什么都不做」,会隐藏失败;放弃语义必须用 null。',
  '- 页面有验证码（登录/注册等）时,在密码填写与提交点击之间编出一条 {"kind":"aiTask","instruction":"识别验证码图片中的字符并填入验证码输入框"}:回放时由 AI 智能体实时截图识别并填入,不要给验证码输入框编普通 fill（填录制/生成的假值回放必失败）。其他难以固化为 DSL 的动态交互（图形验证、Canvas 控件、复杂弹窗等）同样优先用 aiTask。',
  '- aiTask 不预编译,compiled 里原样保留即可（不要把它展开成其它 kind,也不要因它把 compiled 置 null）。',
];

/** stage_case 前瞻变量体检（与 stage_case_op 的 prospectiveVarNote 同方向）:
 *  datasetLocalId 指向的暂存数据集列作为初始变量,对全部步骤 compiled 计算体检,
 *  让 AI 在暂存时（而非回放时）发现 {{变量}} 与数据集列名不一致 / 未定义 / 前向引用。 */
async function caseVarNote(threadId: string, body: StagedCase): Promise<string> {
  const actions = (body.steps ?? []).flatMap((s): StepAction[] => {
    const c = (s as { compiled?: unknown } | null)?.compiled;
    return Array.isArray(c) ? c.filter((a): a is StepAction => !!((a as { kind?: string }).kind)) : [];
  });
  if (actions.length === 0) return '';
  let initialVars: string[] | undefined;
  if (body.datasetLocalId) {
    const row = (await db
      .select({ columns: aiStageDatasets.columns })
      .from(aiStageDatasets)
      .where(and(eq(aiStageDatasets.threadId, threadId), eq(aiStageDatasets.localId, body.datasetLocalId))))[0];
    if (!row) return `变量体检:datasetLocalId ${body.datasetLocalId} 不在暂存区,无法校验变量名(落库时将不绑定该数据集)`;
    initialVars = ((row.columns ?? []) as Array<{ name: string }>).map((c) => c.name);
  }
  const report = buildVariableReport(actions, initialVars);
  const notes = [
    ...report.undefined.map((x) => `引用未定义变量 {{${x.name}}}(${x.field})`),
    ...report.forwardRefs.map((x) => `前向引用 {{${x.name}}}`),
    ...report.invalidNames.map((x) => `变量名 ${x.name} 不合法`),
  ];
  // 宽松兜底:VAR_RE 只认 ASCII 标识符,中文等非法名(如 {{邮箱}})会被体检与回放替换双双静默跳过,
  // 这里用宽松 {{...}} 扫描点名 —— 回放时它们会以字面量填入,必须当场暴露。
  for (const m of JSON.stringify(actions).matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const raw = m[1]!;
    if (!VAR_NAME_RE.test(raw)) notes.push(`变量引用 {{${raw}}} 不是合法变量名(仅字母/数字/下划线),须与数据集列名逐字一致`);
  }
  return notes.length > 0 ? `变量体检:${[...new Set(notes)].join(';')}` : '变量体检:通过';
}

export function buildStageTools(ctx: SpaceToolsContext): ToolExecutor[] {
  return [
    {
      name: 'stage_case',
      description: '暂存一个用例到当前线程的草稿区。localId 必须由调用方生成 UUID v4。steps[].action 是人类可读指令;steps[].compiled 是可回放 DSL 步骤数组（生成时必须给出,规则见 promptGuidelines;放弃用 null）。页面 URL/locator 未知时先调 inspect_page。配套数据集用 datasetLocalId 绑定同批 stage_dataset 的 localId。',
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
        datasetLocalId: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()])),
      }),
      promptGuidelines: STAGE_PROMPT_GUIDELINES,
      execute: async (input) => {
        const v = StageCaseInput.safeParse(input);
        if (!v.success) return { ok: false, error: `参数不合法:${v.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
        // compiled 防御性归一化:空数组 [] → null（LLM 把「放弃」误写成空数组会隐藏失败,必须映射为放弃语义）
        const steps = (v.data.steps ?? []).map((s) => ({
          ...s,
          compiled: Array.isArray(s.compiled) && s.compiled.length === 0 ? null : s.compiled,
        }));
        const body: StagedCase = { ...v.data, steps };
        await stageCase(ctx.threadId, ctx.versionId, body);
        emitStage(ctx, { kind: 'case', id: v.data.localId, action: 'stage', payload: { ...body, stagedAt: new Date().toISOString() } });
        const varNote = await caseVarNote(ctx.threadId, body).catch(() => '');
        return { ok: true, data: `已暂存用例「${v.data.title}」(草稿 ${v.data.localId});用户将在右侧预览区勾选 → 选目标分组 → 落库。${varNote ? `\n${varNote}` : ''}` };
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
        const body: StagedScenario = { ...v.data, caseLocalIds: v.data.caseLocalIds ?? [] };
        await stageScenario(ctx.threadId, ctx.versionId, body);
        emitStage(ctx, { kind: 'scenario', id: v.data.localId, action: 'stage', payload: { ...body, stagedAt: new Date().toISOString() } });
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
        const body: StagedEnvironment = { ...v.data, objects: v.data.objects ?? [] };
        await stageEnvironment(ctx.threadId, ctx.versionId, body);
        emitStage(ctx, { kind: 'environment', id: v.data.localId, action: 'stage', payload: { ...body, stagedAt: new Date().toISOString() } });
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
        const body: StagedPlan = { ...v.data, caseLocalIds: v.data.caseLocalIds ?? [] };
        await stagePlan(ctx.threadId, ctx.versionId, body);
        emitStage(ctx, { kind: 'plan', id: v.data.localId, action: 'stage', payload: { ...body, stagedAt: new Date().toISOString() } });
        return { ok: true, data: `已暂存计划「${v.data.name}」` };
      },
    },
    {
      name: 'stage_dataset',
      description: '暂存一个数据集（列定义 + 行数据）到当前线程的草稿区。列名即回放变量 {{列名}}（合法变量名：字母/下划线开头）;敏感列标 sensitive:true,值以明文给出（落库时自动加密）。配套用例用 stage_case 的 datasetLocalId 绑定本工具的 localId。仅生成新数据集,修改已有数据集暂不支持。',
      parameters: Type.Object({
        localId: Type.String({ minLength: 1, maxLength: 64 }),
        name: Type.String({ minLength: 1, maxLength: 120 }),
        description: Type.Optional(Type.Union([Type.String({ maxLength: 4000 }), Type.Null()])),
        columns: Type.Array(Type.Object({
          name: Type.String({ minLength: 1, maxLength: 64 }),
          sensitive: Type.Optional(Type.Boolean()),
        }), { minItems: 1, maxItems: 30 }),
        rows: Type.Optional(Type.Array(Type.Object({
          disabled: Type.Optional(Type.Boolean()),
          cells: Type.Record(Type.String(), Type.String()),
        }), { maxItems: 500 })),
      }),
      promptGuidelines: STAGE_PROMPT_GUIDELINES,
      execute: async (input) => {
        const v = StageDatasetInput.safeParse(input);
        if (!v.success) return { ok: false, error: `参数不合法:${v.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
        const body: StagedDataset = { ...v.data, rows: v.data.rows ?? [] };
        await stageDataset(ctx.threadId, ctx.versionId, body);
        emitStage(ctx, { kind: 'dataset', id: v.data.localId, action: 'stage', payload: { ...body, stagedAt: new Date().toISOString() } });
        const sensitive = body.columns.filter((c) => c.sensitive).map((c) => c.name);
        return {
          ok: true,
          data: `已暂存数据集「${v.data.name}」（${body.columns.length} 列 × ${body.rows.length} 行${sensitive.length ? `,敏感列:${sensitive.join(',')}(落库时加密)` : ''}）;用户将在右侧预览区勾选 → 落库。`,
        };
      },
    },
  ];
}
