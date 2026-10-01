import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { testSteps, testCases, testAttachments, groups } from '../db/schema.js';
import { eq, asc, and, inArray, sql } from 'drizzle-orm';
import { StepAction } from '@itest/shared';
import { HttpError } from '../middleware/errorHandler.js';
import { compileAiStep, compileAiStepsInPlace } from '../agent/aiStepCompile.js';
import { splitAiStepsInPlace } from '../agent/aiStepSplit.js';
import { encrypt, ensureKeyLoaded } from '../lib/secret-crypto.js';
import { migrateAction } from '../lib/step-migration.js';
import { buildVariableReport } from '../lib/variable-report.js';
import { assertCaseVisible } from '../services/projectAccess.js';

export const stepsRoute = Router();

const AppendBody = z.object({
  steps: z
    .array(
      z.object({
        order: z.number().int().nonnegative(),
        source: z.enum(['agent', 'recorder', 'manual']),
        action: StepAction,
        assertion: z.unknown().optional(),
      }),
    )
    .min(1),
});

stepsRoute.post('/:caseId/steps', async (req, res) => {
  const body = AppendBody.parse(req.body);
  const exists = await db.select().from(testCases).where(eq(testCases.id, req.params.caseId));
  if (exists.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  await assertCaseVisible(req.params.caseId!, req.user!);
  splitAiStepsInPlace(body.steps);
  // 拆条后片段会复制原 order；重排为接续现有最大 order 的连续序号，避免重复。
  const maxRow = await db
    .select({ maxOrder: sql<number>`coalesce(max(${testSteps.order}), 0)` })
    .from(testSteps)
    .where(eq(testSteps.caseId, req.params.caseId));
  const base = Number(maxRow[0]?.maxOrder ?? 0);
  body.steps.forEach((s, i) => {
    s.order = base + i + 1;
  });
  const failedAi = await compileAiStepsInPlace(body.steps.map((s) => ({ action: s.action })));
  const variableReport = buildVariableReport(body.steps.map((s) => s.action));
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
      body.steps.map((s) => ({
        caseId: req.params.caseId,
        order: s.order,
        source: s.source,
        action: s.action as object,
        assertion: (s.assertion ?? null) as object | null,
      })),
    )
    .returning();
  const sorted = await db
    .select()
    .from(testSteps)
    .where(eq(testSteps.caseId, req.params.caseId))
    .orderBy(asc(testSteps.order));
  res.json({ count: rows.length, steps: sorted, failedAi, variableReport });
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

/** 全量替换步骤（步骤维护/粘贴/撤销的统一写入口）。aiStep 保存前自动编译。 */
stepsRoute.put('/:caseId/steps', async (req, res) => {
  const body = z
    .object({
      steps: z.array(
        z.object({
          action: StepAction,
          source: z.enum(['agent', 'recorder', 'manual']).default('manual'),
          name: z.string().max(200).optional(),
          delayMs: z.number().int().nonnegative().max(60000).optional(),
        }),
      ),
    })
    .parse(req.body);
  for (const s of body.steps) {
    s.action = migrateAction(s.action) as typeof s.action;
  }
  splitAiStepsInPlace(body.steps);
  const exists = await db.select().from(testCases).where(eq(testCases.id, req.params.caseId));
  if (exists.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  await assertCaseVisible(req.params.caseId!, req.user!);
  // Project-scope: resolve the case's projectId once via its group, then enforce project membership.
  const groupId = exists[0]!.groupId;
  const g = (await db.select().from(groups).where(eq(groups.id, groupId)))[0];
  if (!g) throw new HttpError(404, 'not_found', 'group not found');
  const caseProjectId = g.projectId;
  for (const s of body.steps) {
    const a = s.action as { kind?: string; fileId?: string; sensitive?: boolean };
    if (a.kind === 'upload') {
      const fileId = a.fileId;
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
    if (a.kind === 'fill' && a.sensitive) {
      ensureKeyLoaded();
    }
  }
  const failedAi = await compileAiStepsInPlace(
    body.steps.map((s) => ({ action: s.action, name: s.name })),
  );
  const variableReport = buildVariableReport(body.steps.map((s) => s.action));
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
          const a = s.action as { kind?: string; value?: unknown; sensitive?: boolean };
          let secretCiphertext: string | null = null;
          let secretIv: string | null = null;
          let secretTag: string | null = null;
          let storedAction: unknown = s.action;
          if (a.kind === 'fill' && a.sensitive) {
            const enc = encrypt(String(a.value ?? ''));
            secretCiphertext = enc.ciphertext.toString('base64');
            secretIv = enc.iv.toString('base64');
            secretTag = enc.tag.toString('base64');
            storedAction = { ...(s.action as object), value: '__sensitive__' };
          }
          return {
            caseId: req.params.caseId,
            order: i + 1,
            source: s.source,
            action: storedAction as object,
            name: s.name ?? null,
            delayMs: s.delayMs ?? null,
            sensitive: a.kind === 'fill' && !!a.sensitive,
            secretCiphertext,
            secretIv,
            secretTag,
          };
        }),
      )
      .returning();
  });
  res.json({ steps: rows.sort((a, b) => a.order - b.order), failedAi, variableReport });
});

/** 单独编译一条 AI 指令（步骤编辑页「重新编译」）。失败返回 compiled: null，不抛错。 */
stepsRoute.post('/:caseId/steps/recompile', async (req, res) => {
  const { instruction } = z.object({ instruction: z.string().min(1) }).parse(req.body);
  const exists = await db.select().from(testCases).where(eq(testCases.id, req.params.caseId));
  if (exists.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  await assertCaseVisible(req.params.caseId!, req.user!);
  try {
    res.json({ compiled: await compileAiStep(instruction) });
  } catch {
    res.json({ compiled: null });
  }
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