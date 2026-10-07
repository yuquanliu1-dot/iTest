import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { testSteps, testCases, testAttachments, groups, datasets } from '../db/schema.js';
import { eq, asc, and, inArray, sql } from 'drizzle-orm';
import { StepAction } from '@itest/shared';
import { HttpError } from '../middleware/errorHandler.js';
import { encrypt, ensureKeyLoaded } from '../lib/secret-crypto.js';
import { migrateAction, sanitizeAssertion } from '../lib/step-migration.js';
import { buildVariableReport } from '../lib/variable-report.js';
import { assertCaseVisible } from '../services/projectAccess.js';

export const stepsRoute = Router();

const AppendBody = z.object({
  steps: z
    .array(
      z.object({
        order: z.number().int().nonnegative(),
        source: z.enum(['agent', 'recorder', 'manual']),
        // 2026-10-07：action 允许缺省 —— compiled 是 source of truth,新 client 不传 action。
        // POST 老路径继续严格:action 传了必须合 StepAction 规范,否则 400。
        action: StepAction.optional(),
        assertion: z.unknown().optional(),
        instruction: z.string().max(2000).optional(),
        compiled: z.array(z.unknown()).optional(),
      }),
    )
    .min(1),
});

stepsRoute.post('/:caseId/steps', async (req, res) => {
  const body = AppendBody.parse(req.body);
  const exists = await db.select().from(testCases).where(eq(testCases.id, req.params.caseId));
  if (exists.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  await assertCaseVisible(req.params.caseId!, req.user!);
  // 绑定数据集的列名 = 回放初始变量（与 PUT 替换路由一致），datasetId 为 null 时不传。
  let initialVars: string[] | undefined;
  if (exists[0]!.datasetId) {
    const ds = (await db.select().from(datasets).where(eq(datasets.id, exists[0]!.datasetId)).limit(1))[0];
    if (ds) initialVars = ds.columns.map((c) => c.name);
  }
  // 重排为接续现有最大 order 的连续序号，避免重复。
  const maxRow = await db
    .select({ maxOrder: sql<number>`coalesce(max(${testSteps.order}), 0)` })
    .from(testSteps)
    .where(eq(testSteps.caseId, req.params.caseId));
  const base = Number(maxRow[0]?.maxOrder ?? 0);
  body.steps.forEach((s, i) => {
    s.order = base + i + 1;
  });
  const variableReport = buildVariableReport(
    body.steps
      .map((s) => s.action)
      .filter((a): a is StepAction => !!a && !!((a as { kind?: string }).kind) && ((a as { locator?: unknown[] }).locator?.length ?? 0) > 0),
    initialVars,
  );
  if (variableReport.regexIssues.length > 0) {
    throw new HttpError(
      422,
      'variable_regex_unsafe',
      variableReport.regexIssues.map((i) => `step ${i.stepOrder + 1}: ${i.reason}`).join('; '),
    );
  }
  const rows = await db
    .insert(testSteps)
    .values(
      body.steps.map((s) => {
        // 手动改步骤路径也走 sanitize + migrate：客户端已传规范 StepAction 时也再过一遍 sanitize
        // （从 `equals` 字段提取字符串），保证描述性断言不会通过该入口溜进库。
        const raw = s.assertion as { equals?: unknown; text?: unknown } | null | undefined;
        const text = typeof raw?.equals === 'string'
          ? raw.equals
          : typeof raw?.text === 'string'
            ? raw.text
            : null;
        const clean = sanitizeAssertion(text);
        const assertion = clean !== null
          ? (migrateAction({ kind: 'assertText', text: clean }) as object)
          : null;
        const a = s.action as { kind?: string; url?: string; value?: unknown } | undefined;
        const c0 = (Array.isArray(s.compiled) && s.compiled.length > 0
          ? (s.compiled[0] as { kind?: string; url?: string; value?: unknown })
          : undefined);
        const a2 = a ?? c0 ?? {};
        const fallbackInstruction = s.instruction?.trim() || (() => {
          switch (a2.kind) {
            case 'navigate': return `打开 ${a2.url ?? ''}`;
            case 'click': return '点击';
            case 'fill': return `输入 ${typeof a2.value === 'string' ? a2.value : '...'}`;
            default: return a2.kind ?? '';
          }
        })();
        // compiled 元素做 migrate 同步:sensitive 字段保留(由 dispatcher 决定是否入密),value 入密后从 compiled 里抹掉避免泄漏。
        const compiled = Array.isArray(s.compiled)
          ? (s.compiled.map((c) => {
              const m = migrateAction(c) as Record<string, unknown>;
              if (m && m.kind === 'fill' && m.sensitive) delete m.value;
              return m;
            }) as unknown[])
          : null;
        return {
          caseId: req.params.caseId,
          order: s.order,
          source: s.source,
          instruction: fallbackInstruction.slice(0, 2000),
          compiled,
          assertion,
        };
      }),
    )
    .returning();
  const sorted = await db
    .select()
    .from(testSteps)
    .where(eq(testSteps.caseId, req.params.caseId))
    .orderBy(asc(testSteps.order));
  res.json({ count: rows.length, steps: sorted, variableReport });
});

const ReorderBody = z.object({ stepIds: z.array(z.string().uuid()).min(1) });

/** 按传入的 id 顺序重排（stepIds 须恰好覆盖该用例全部步骤），order 重写为 1..n。 */
stepsRoute.put('/:caseId/steps/reorder', async (req, res) => {
  const { stepIds } = ReorderBody.parse(req.body);
  await assertCaseVisible(req.params.caseId!, req.user!);
  const rows = await db
    .select()
    .from(testSteps)
    .where(eq(testSteps.caseId, req.params.caseId))
    .orderBy(asc(testSteps.order));
  const existing = new Set(rows.map((r) => r.id));
  if (stepIds.length !== rows.length || !stepIds.every((id) => existing.has(id))) {
    throw new HttpError(400, 'invalid_order', 'stepIds must cover exactly the case steps');
  }
  for (let i = 0; i < stepIds.length; i++) {
    await db.update(testSteps).set({ order: i + 1 }).where(eq(testSteps.id, stepIds[i]!));
  }
  const sorted = await db
    .select()
    .from(testSteps)
    .where(eq(testSteps.caseId, req.params.caseId))
    .orderBy(asc(testSteps.order));
  res.json({ steps: sorted });
});

stepsRoute.delete('/:caseId/steps/:stepId', async (req, res) => {
  await assertCaseVisible(req.params.caseId!, req.user!);
  const rows = await db
    .select()
    .from(testSteps)
    .where(eq(testSteps.caseId, req.params.caseId))
    .orderBy(asc(testSteps.order));
  const target = rows.find((r) => r.id === req.params.stepId);
  if (!target) throw new HttpError(404, 'not_found', 'step not found');
  const remaining = rows.filter((r) => r.id !== target.id).map((r) => r.id);
  await db.delete(testSteps).where(inArray(testSteps.id, [target.id]));
  // 剩余步骤 order 紧凑化为 1..n
  for (let i = 0; i < remaining.length; i++) {
    await db.update(testSteps).set({ order: i + 1 }).where(eq(testSteps.id, remaining[i]!));
  }
  res.json({ ok: true });
});

/** 全量替换步骤（步骤维护/粘贴/撤销的统一写入口）。 */
stepsRoute.put('/:caseId/steps', async (req, res) => {
  const body = z
    .object({
      steps: z.array(
        z.object({
          // 2026-10-07：放宽 action —— locator 允许空数组（占位未编译步骤）,
          //   dispatch 读 compiled 时仍会抛 compile-missing 阻断执行。
          // 用 z.union 拆三档：
          //   1) StepAction(规范)  2) PlaceholderAction(kind 存在但 locator 缺省)
          //   3) EmptyAction({} 兜底) —— 老数据「等待页面跳转到…」等无具体 kind 的步骤,
          //      action 已存为 {},再保存时若按原值上传会绕 Z。
          // action 可缺省 —— compiled 是 2026-10-06 起的 source of truth,旧 UI 可能不传 action。
          action: z
            .union([
              StepAction,
              z.object({
                kind: z.string().min(1),
                locator: z.array(z.unknown()).default([]),
              }).passthrough(),
              z.object({}).passthrough(),
            ])
            .optional(),
          source: z.enum(['agent', 'recorder', 'manual']).default('manual'),
          delayMs: z.number().int().nonnegative().max(60000).optional(),
          /** 行级自然语言（人看/给 LLM 起手用；回放不读）。必填,缺省时由 action 内容拼一行兜底。 */
          instruction: z.string().max(2000).optional(),
          /** 已编译 DSL 数组；缺省时按"未编译"处理（dispatcher 阻塞执行）。 */
          compiled: z.array(z.unknown()).optional(),
        }),
      ),
    })
    .parse(req.body);
  for (const s of body.steps) {
    if (s.action) s.action = migrateAction(s.action) as typeof s.action;
  }
  const exists = await db.select().from(testCases).where(eq(testCases.id, req.params.caseId));
  if (exists.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  await assertCaseVisible(req.params.caseId!, req.user!);
  // Project-scope: resolve the case's projectId once via its group, then enforce project membership.
  const groupId = exists[0]!.groupId;
  const g = (await db.select().from(groups).where(eq(groups.id, groupId)))[0];
  if (!g) throw new HttpError(404, 'not_found', 'group not found');
  const caseProjectId = g.projectId;
  // 绑定数据集的列名 = 回放初始变量：体检时传入 buildVariableReport，避免 {{列名}} 被误报未定义。
  let initialVars: string[] | undefined;
  if (exists[0]!.datasetId) {
    const ds = (await db.select().from(datasets).where(eq(datasets.id, exists[0]!.datasetId)).limit(1))[0];
    if (ds) initialVars = ds.columns.map((c) => c.name);
  }
  for (const s of body.steps) {
    // upload/sensitive 等语义检查从 compiled[0] 读取(action 可能缺省 —— 2026-10-07 起 compiled 是 source of truth)。
    const c0 = (Array.isArray(s.compiled) && s.compiled.length > 0
      ? (s.compiled[0] as { kind?: string; fileId?: string; sensitive?: boolean; value?: unknown })
      : undefined);
    const a = s.action as { kind?: string; fileId?: string; sensitive?: boolean; locator?: unknown[] } | undefined;
    const kind = a?.kind ?? c0?.kind;
    // 2026-10-07：占位未编译行 (compiled 为空数组) 跳过 upload/sensitive 等具体字段语义检查 —— 它反正不会被 dispatcher 派发。
    // action 缺省时,如果 compiled 非空就走正常检查(只靠 compiled 决定语义)。
    const isPlaceholder = Array.isArray(s.compiled) && s.compiled.length === 0;
    if (isPlaceholder) continue;
    if (kind === 'upload') {
      const fileId = a?.fileId ?? c0?.fileId;
      if (!fileId) throw new HttpError(422, 'upload_no_file', 'upload step requires fileId');
      // Defend against non-UUID strings: validate shape before hitting Postgres.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fileId)) {
        throw new HttpError(422, 'upload_unknown_file', `attachment ${fileId} not found`);
      }
      // Project-scoped: fileId must belong to the same project as the case.
      const row = await db
        .select()
        .from(testAttachments)
        .where(and(eq(testAttachments.id, fileId), eq(testAttachments.projectId, caseProjectId)));
      if (row.length === 0) throw new HttpError(422, 'upload_unknown_file', `attachment ${fileId} not found`);
    }
    if (kind === 'fill' && (a?.sensitive ?? c0?.sensitive)) {
      ensureKeyLoaded();
    }
  }
  // 2026-10-07：体检输入按 compiled 全量扁平化（多动作链里第 2+ 个动作的 {{var}} 也要扫）；
  // 老数据无 compiled 时回退 action（须有 kind 且 locator 非空）。占位（compiled 空数组）自然跳过。
  // 扁平化后动作下标 ≠ 步骤下标，记录每个动作所属步骤下标，把 report 里的 order 重映射回步骤序号
  // （UI/报错文案按"步骤 N"展示，N 必须对得上 steps 列表）。
  const stepIndexOfAction: number[] = [];
  const actionsForReport = body.steps.flatMap((s, si): StepAction[] => {
    if (Array.isArray(s.compiled)) {
      const acts = s.compiled.filter((c): c is StepAction => !!((c as { kind?: string }).kind));
      acts.forEach(() => stepIndexOfAction.push(si));
      return acts;
    }
    const a = s.action as { kind?: string; locator?: unknown[] } | undefined;
    if (a?.kind && (a.locator?.length ?? 0) > 0) {
      stepIndexOfAction.push(si);
      return [a as StepAction];
    }
    return [];
  });
  const rawReport = buildVariableReport(actionsForReport, initialVars);
  const stepOf = (i: number) => stepIndexOfAction[i] ?? i;
  const variableReport = {
    ...rawReport,
    undefined: rawReport.undefined.map((v) => ({ ...v, stepOrder: stepOf(v.stepOrder) })),
    forwardRefs: rawReport.forwardRefs.map((v) => ({ ...v, stepOrder: stepOf(v.stepOrder) })),
    regexIssues: rawReport.regexIssues.map((v) => ({ ...v, stepOrder: stepOf(v.stepOrder) })),
    invalidNames: rawReport.invalidNames.map((v) => ({ ...v, stepOrder: stepOf(v.stepOrder) })),
    duplicates: rawReport.duplicates.map((d) => ({ ...d, definedAt: d.definedAt.map(stepOf) })),
  };
  if (variableReport.regexIssues.length > 0) {
    throw new HttpError(
      422,
      'variable_regex_unsafe',
      variableReport.regexIssues.map((i) => `step ${i.stepOrder + 1}: ${i.reason}`).join('; '),
    );
  }
  const rows = await db.transaction(async (tx) => {
    await tx.delete(testSteps).where(eq(testSteps.caseId, req.params.caseId));
    if (body.steps.length === 0) return [];
    return tx
      .insert(testSteps)
      .values(
        body.steps.map((s, i) => {
          const c0 = (Array.isArray(s.compiled) && s.compiled.length > 0
            ? (s.compiled[0] as { kind?: string; fileId?: string; sensitive?: boolean; value?: unknown })
            : undefined);
          const a = s.action as { kind?: string; value?: unknown; sensitive?: boolean } | undefined;
          let secretCiphertext: string | null = null;
          let secretIv: string | null = null;
          let secretTag: string | null = null;
          const kind = a?.kind ?? c0?.kind;
          const sensitive = a?.sensitive ?? c0?.sensitive;
          const value = a?.value ?? c0?.value;
          if (kind === 'fill' && sensitive) {
            const enc = encrypt(String(value ?? ''));
            secretCiphertext = enc.ciphertext.toString('base64');
            secretIv = enc.iv.toString('base64');
            secretTag = enc.tag.toString('base64');
          }
          // compiled 是回放唯一依据,客户端可能只传 compiled(action 缺省),
          // 此处对 compiled 元素补一遍 migrate 以保证存储形态规范(老 client 行为兼容)。
          // 同时:sensitive 字段写入时一定要抹掉,value 入密后也抹掉(避免 JSON 回写泄漏)。
          const compiled = Array.isArray(s.compiled)
            ? (s.compiled.map((c) => {
                const m = migrateAction(c) as Record<string, unknown>;
                if (m && m.kind === 'fill' && m.sensitive) {
                  delete m.value;
                }
                return m;
              }) as unknown[])
            : null;
          // instruction 缺省时按 action 内容自动拼一行(2026-10-07 name 列退役,此处不再写 name 列)。
          // action 缺省时优先从 compiled[0] 取 kind/url/value 拼。
          const fallbackInstruction = s.instruction?.trim()
            || (() => {
                const a2 = s.action as { kind?: string; url?: string; value?: unknown; tabRef?: string } | undefined;
                const c0b = (Array.isArray(compiled) && compiled.length > 0
                  ? (compiled[0] as { kind?: string; url?: string; value?: unknown; tabRef?: string })
                  : undefined);
                const knd = a2?.kind ?? c0b?.kind;
                switch (knd) {
                  case 'navigate': return `打开 ${a2?.url ?? c0b?.url ?? ''}`;
                  case 'click': return '点击';
                  case 'fill': return `输入 ${typeof (a2?.value ?? c0b?.value) === 'string' ? (a2?.value ?? c0b?.value) : '...'}`;
                  case 'switchTab': return `切换标签页 ${a2?.tabRef ?? c0b?.tabRef ?? ''}`;
                  default: return a2 ? JSON.stringify(a2) : (c0b ? JSON.stringify(c0b) : '');
                }
              })();
          return {
            caseId: req.params.caseId,
            order: i + 1,
            source: s.source,
            instruction: fallbackInstruction.slice(0, 2000),
            compiled,
            delayMs: s.delayMs ?? null,
            sensitive: kind === 'fill' && !!sensitive,
            secretCiphertext,
            secretIv,
            secretTag,
          };
        }),
      )
      .returning();
  });
  res.json({ steps: rows.sort((a, b) => a.order - b.order), variableReport });
});

const CompileExtractBody = z.object({
  description: z.string().min(1).max(500),
  sampleText: z.string().min(1).max(5000),
});

/** 智能抽取编译：根据用户自然语言描述 + 样本文本，调用 LLM 生成正则。失败返回 200 + error 字段。 */
stepsRoute.post('/:caseId/steps/extract/compile', async (req, res) => {
  const { description, sampleText } = CompileExtractBody.parse(req.body);
  const exists = await db.select().from(testCases).where(eq(testCases.id, req.params.caseId));
  if (exists.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  await assertCaseVisible(req.params.caseId!, req.user!);
  const { compileExtractRegex } = await import('../lib/extract-compile.js');
  try {
    const out = await compileExtractRegex(description, sampleText);
    res.json(out);
  } catch (e) {
    res.json({ pattern: null, group: 0, error: (e as Error).message });
  }
});

