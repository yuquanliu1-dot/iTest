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
import { invalidateCasesCacheForCase } from '../services/cases.service.js';

export const stepsRoute = Router();

const AppendBody = z.object({
  steps: z
    .array(
      z.object({
        order: z.number().int().nonnegative(),
        source: z.enum(['agent', 'recorder', 'manual']),
        // 2026-10-07: action may be absent — compiled is the source of truth, new clients don't send action.
        // The old POST path stays strict: if action is sent it must conform to the StepAction spec, otherwise 400.
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
  // Column names of the bound dataset = replay initial variables (same as the PUT replacement route); not sent when datasetId is null.
  let initialVars: string[] | undefined;
  if (exists[0]!.datasetId) {
    const ds = (await db.select().from(datasets).where(eq(datasets.id, exists[0]!.datasetId)).limit(1))[0];
    if (ds) initialVars = ds.columns.map((c) => c.name);
  }
  // Reorder into consecutive numbers continuing from the existing max order, avoiding duplicates.
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
        // The manual step-edit path also goes through sanitize + migrate: even when the client already sent a canonical
        // StepAction, sanitize runs again (extracting the string from the `equals` field), ensuring descriptive assertions
        // don't sneak into the DB through this entry.
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
        // instruction stored as empty when absent — the display layer (case page/report page) has stepSummary as a
        // real-time fallback, so the server no longer fabricates bare labels like "click" (they would obscure the live
        // summary and pollute AI fallback input).
        const instruction = s.instruction?.trim() ?? '';
        // compiled elements get a migrate sync: the sensitive field is kept (the dispatcher decides whether to encrypt),
        // and value is erased from compiled after encryption to avoid leakage.
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
          instruction,
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
  await invalidateCasesCacheForCase(req.params.caseId!);
  res.json({ count: rows.length, steps: sorted, variableReport });
});

const ReorderBody = z.object({ stepIds: z.array(z.string().uuid()).min(1) });

/** Reorder by the given id order (stepIds must cover exactly all of the case's steps); order rewritten to 1..n. */
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
  await invalidateCasesCacheForCase(req.params.caseId!);
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
  // Remaining steps' orders compacted to 1..n
  for (let i = 0; i < remaining.length; i++) {
    await db.update(testSteps).set({ order: i + 1 }).where(eq(testSteps.id, remaining[i]!));
  }
  await invalidateCasesCacheForCase(req.params.caseId!);
  res.json({ ok: true });
});

/** Full replacement of steps (the unified write entry for step maintenance/paste/undo). */
stepsRoute.put('/:caseId/steps', async (req, res) => {
  const body = z
    .object({
      steps: z.array(
        z.object({
          // 2026-10-07: action relaxed — locator may be an empty array (placeholder unsolidified steps);
          //   dispatch still throws compile-missing when reading compiled, blocking execution.
          // z.union splits into three tiers:
          //   1) StepAction (canonical)  2) PlaceholderAction (kind present but locator absent)
          //   3) EmptyAction ({} fallback) — legacy data like "wait for page to navigate to..." with no concrete kind;
          //      action was stored as {}, and re-saving it as-is would bypass Z.
          // action may be absent — compiled is the source of truth since 2026-10-06; the old UI might not send action.
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
          /** Row-level natural language (for humans / LLM starting point; replay doesn't read it). Stored as empty when absent; display layer falls back to stepSummary. */
          instruction: z.string().max(2000).optional(),
          /** Compiled DSL array; treated as "unsolidified" when absent (the dispatcher blocks execution). */
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
  // Column names of the bound dataset = replay initial variables: passed into buildVariableReport during the checkup, so {{columnName}} isn't falsely reported as undefined.
  let initialVars: string[] | undefined;
  if (exists[0]!.datasetId) {
    const ds = (await db.select().from(datasets).where(eq(datasets.id, exists[0]!.datasetId)).limit(1))[0];
    if (ds) initialVars = ds.columns.map((c) => c.name);
  }
  for (const s of body.steps) {
    // upload/sensitive semantic checks read from compiled[0] (action may be absent — compiled is the source of truth since 2026-10-07).
    const c0 = (Array.isArray(s.compiled) && s.compiled.length > 0
      ? (s.compiled[0] as { kind?: string; fileId?: string; sensitive?: boolean; value?: unknown })
      : undefined);
    const a = s.action as { kind?: string; fileId?: string; sensitive?: boolean; locator?: unknown[] } | undefined;
    const kind = a?.kind ?? c0?.kind;
    // 2026-10-07: placeholder unsolidified rows (compiled is an empty array) skip concrete-field semantic checks like upload/sensitive — they won't be dispatched by the dispatcher anyway.
    // When action is absent but compiled is non-empty, run the normal checks (semantics decided by compiled alone).
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
  // 2026-10-07: checkup input fully flattened over compiled (the {{var}} of the 2nd+ actions in multi-action chains must be scanned too);
  // legacy data without compiled falls back to action (must have kind and a non-empty locator). Placeholders (empty compiled array) naturally skip.
  // After flattening, the action index ≠ the step index, so record each action's owning step index and remap the report's order back to step numbers
  // (UI/error text presents "step N", and N must line up with the steps list).
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
          // compiled is the sole basis for replay, and the client may send only compiled (action absent),
          // so compiled elements get a migrate pass here to keep the stored shape canonical (backward compatible with old clients).
          // Also: the sensitive field must always be erased on write, and value erased after encryption (avoiding JSON write-back leakage).
          const compiled = Array.isArray(s.compiled)
            ? (s.compiled.map((c) => {
                const m = migrateAction(c) as Record<string, unknown>;
                if (m && m.kind === 'fill' && m.sensitive) {
                  delete m.value;
                }
                return m;
              }) as unknown[])
            : null;
          // instruction stored as empty when absent — the display layer (case page/report page) has stepSummary as a
          // real-time fallback, so the server no longer fabricates bare labels like "click" (they would obscure the live
          // summary and pollute AI fallback input).
          const instruction = s.instruction?.trim() ?? '';
          return {
            caseId: req.params.caseId,
            order: i + 1,
            source: s.source,
            instruction,
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
  await invalidateCasesCacheForCase(req.params.caseId!);
  res.json({ steps: rows.sort((a, b) => a.order - b.order), variableReport });
});

const CompileExtractBody = z.object({
  description: z.string().min(1).max(500),
  sampleText: z.string().min(1).max(5000),
});

/** Smart extraction compile: given the user's natural-language description + sample text, call the LLM to generate a regex. On failure returns 200 + an error field. */
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

