/**
 * Exploratory testing session routes: charter-driven → AI proactively hunts for issues in a real browser
 * → findings (defect candidates + evidence screenshots) → human confirms/dismisses → confirmed items can be
 * promoted into case drafts (the platform's action trail provides best-effort mechanical DSL; the rest goes
 * through the existing AI compilation flow).
 *
 * Session execution goes through the exec queue (kind:'exploration'), sharing the plan-run/single-case chromium
 * concurrency gate.
 * Cancellation uses the DB column cancel_requested (naturally correct across replicas); the worker polls it once per turn.
 */
import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { explorationFindings, explorationSessions, groups } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { assertProjectVisible, assertVersionVisible, visibleProjectIds } from '../services/projectAccess.js';
import { handleLiveView, handleLiveReplay, handleLiveReplayMeta, replaySpeedOf } from '../execute/liveView.js';
import { getExecutionQueue, isExecutionQueueReady, EXEC_QUEUE_NAME } from '../scheduler/execQueue.js';
import { runExplorationSession, removeExplorationScreenshots } from '../execute/exploration.js';
import { trailToCaseSteps, mergeExplorationTrails } from '../execute/explorationPrompt.js';
import { parsePaging } from '../lib/pagination.js';
import { createCaseWithSteps } from '../services/cases.service.js';
import { attachCreators } from '../lib/creator.js';
import { logger } from '../logger.js';
import { EXPLORATION_PERSONA_KEYS } from '@itest/shared';

export const explorationsRoute = Router();

const CreateBody = z.object({
  versionId: z.string().uuid(),
  /** Exploration charter: natural-language goal and scope for the AI (10~4000 chars). */
  charter: z.string().trim().min(10).max(4000),
  persona: z.enum(EXPLORATION_PERSONA_KEYS as [string, ...string[]]).default('qa'),
  title: z.string().trim().min(1).max(200).optional(),
  startUrl: z.string().trim().max(2000).optional(),
  /**
   * Destructive operation authorization (denied by default): only with this checked may exploration click
   * irreversible entries like delete/pay/send.
   * Charter wording is not authorization — the mechanical gate only trusts this explicit switch (2026-11-10
   * prod record: the charter asked to verify whether deletion really persisted → the model clicked delete → the asset was truly deleted).
   */
  allowDestructive: z.boolean().default(false),
  /**
   * Fault-injection authorization (denied by default): only with this checked may exploration inject
   * network outage/slow network/CPU throttling to verify error handling and degradation paths.
   * Same policy as allowDestructive — charter wording is not authorization (faults pollute the SUT session state).
   */
  allowFaultInjection: z.boolean().default(false),
  /**
   * Browser viewport width/height (two states: absent = default 1280×800; both given = custom). Only one given → 400 window_required
   * (reuses the case window validation's i18n message).
   */
  windowWidth: z.number().int().positive().optional(),
  windowHeight: z.number().int().positive().optional(),
  /** Turn budget (default 60, 4~240): a soft budget; exceeding it winds down gracefully and all discovered findings are kept.
   *  Session wall-clock is materialized from turns (60s per turn, clamped to 15~240 minutes) — turns are the only depth knob. */
  budgetTurns: z.number().int().min(4).max(240).optional(),
});

const ListQuery = z.object({
  versionId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
});

/**
 * Persona matrix creation (C3): N persona sessions run in parallel on the same charter (grouped by the same matrix_id).
 * No new table — the grouping key/display name/role columns hang off exploration_sessions.
 * Sessions are created one per deduplicated persona; each session = one independent exploration (its own charter decomposition, its own action trail).
 */
const CreateMatrixBody = z.object({
  versionId: z.string().uuid(),
  charter: z.string().trim().min(10).max(4000),
  /** Persona list (1~6, duplicates auto-deduplicated): one session per persona. */
  personas: z.array(z.enum(EXPLORATION_PERSONA_KEYS as [string, ...string[]])).min(1).max(6),
  /** Matrix display name (generated from the persona count when absent). */
  label: z.string().trim().min(1).max(120).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  startUrl: z.string().trim().max(2000).optional(),
  allowDestructive: z.boolean().default(false),
  /** Fault-injection authorization (denied by default): the same explicit switch per session in the matrix — charter wording is not authorization. */
  allowFaultInjection: z.boolean().default(false),
  windowWidth: z.number().int().positive().optional(),
  windowHeight: z.number().int().positive().optional(),
  budgetTurns: z.number().int().min(4).max(240).optional(),
});

/** Session visibility assertion: judged via session.projectId; missing and invisible both 404. */
async function loadSession(sessionId: string, user: { userId: string }) {
  const row = (await db.select().from(explorationSessions).where(eq(explorationSessions.id, sessionId)))[0];
  if (!row) throw new HttpError(404, 'not_found', 'exploration session not found');
  await assertProjectVisible(row.projectId, user as never);
  return row;
}

/**
 * Dispatch an exploration session: enqueue when redis is ready; fall back to inline on add failure; inline directly without redis.
 * Single creation and matrix creation share this — both paths' dispatch semantics must be identical (otherwise matrix sessions would queue/inline differently from single ones).
 */
async function dispatchExploration(sessionId: string): Promise<void> {
  if (isExecutionQueueReady()) {
    try {
      await getExecutionQueue().add(EXEC_QUEUE_NAME, { kind: 'exploration', sessionId });
      return;
    } catch (e) {
      logger.warn({ err: e, sessionId }, 'exec queue add failed; running exploration inline');
    }
  }
  void runExplorationSession({ sessionId });
}

/**
 * Create an exploration session: persist pending → enqueue → return immediately (the frontend polls the detail page for the live view and findings).
 * The three-stage enqueue matches execute.ts: enqueue when redis is ready; fall back to inline on add failure; inline directly without redis.
 * The runner atomically claims pending→running internally, so duplicate dispatches won't run twice.
 */
explorationsRoute.post('/', async (req, res) => {
  const body = CreateBody.parse(req.body);
  // Two-state validation: either neither given (default 1280×800) or both given (custom); only one = incomplete parameters.
  if ((body.windowWidth === undefined) !== (body.windowHeight === undefined)) {
    throw new HttpError(400, 'window_required', 'windowWidth and windowHeight must be provided together');
  }
  const { projectId } = await assertVersionVisible(body.versionId, req.user!);
  const title = body.title?.trim() || body.charter.slice(0, 80);
  const inserted = (await db
    .insert(explorationSessions)
    .values({
      projectId,
      versionId: body.versionId,
      title,
      charter: body.charter,
      persona: body.persona,
      startUrl: body.startUrl?.trim() || null,
      allowDestructive: body.allowDestructive,
      allowFaultInjection: body.allowFaultInjection,
      windowWidth: body.windowWidth ?? null,
      windowHeight: body.windowHeight ?? null,
      budgetTurns: body.budgetTurns ?? null,
      status: 'pending',
      // Scope resolution happens in the runner's background (LLM+git can take tens of seconds) — persist pending first; the frontend polls the detail page for the result.
      codeScopeStatus: 'pending',
      createdByUserId: req.user!.userId,
    })
    .returning())[0]!;
  const sessionId = inserted.id;

  await dispatchExploration(sessionId);

  res.status(201).json(inserted);
});

/** List: filterable by versionId / projectId; if neither is given, return all sessions in the current user's visible projects. */
explorationsRoute.get('/', async (req, res) => {
  const q = ListQuery.parse(req.query);
  const { page, limit } = parsePaging(req.query);
  const filters: SQL[] = [];
  if (q.versionId) {
    // Version filtering still needs the visibility check: otherwise knowing a versionId would suffice to list sessions of the org
    const { projectId } = await assertVersionVisible(q.versionId, req.user!);
    filters.push(eq(explorationSessions.versionId, q.versionId));
    filters.push(eq(explorationSessions.projectId, projectId));
  } else if (q.projectId) {
    await assertProjectVisible(q.projectId, req.user!);
    filters.push(eq(explorationSessions.projectId, q.projectId));
  } else {
    const ids = await visibleProjectIds(req.user!);
    if (ids.length === 0) return res.json({ items: [], total: 0, page, limit });
    filters.push(inArray(explorationSessions.projectId, ids));
  }
  const where = filters.length > 1 ? and(...filters) : filters[0]!;

  const [items, totalRows] = await Promise.all([
    db
      .select()
      .from(explorationSessions)
      .where(where)
      .orderBy(desc(explorationSessions.createdAt))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ count: sql<number>`count(*)::int` }).from(explorationSessions).where(where),
  ]);
  // Defect candidate counts (list page card badges): one grouped query attached to rows — no per-session detail requests (N+1).
  const countRows = items.length
    ? await db
        .select({ sessionId: explorationFindings.sessionId, count: sql<number>`count(*)::int` })
        .from(explorationFindings)
        .where(inArray(explorationFindings.sessionId, items.map((i) => i.id)))
        .groupBy(explorationFindings.sessionId)
    : [];
  const countMap = new Map(countRows.map((r) => [r.sessionId, r.count]));
  res.json({
    items: await attachCreators(items.map((i) => ({ ...i, findingsCount: countMap.get(i.id) ?? 0 }))),
    total: totalRows[0]?.count ?? 0,
    page,
    limit,
  });
});

/**
 * Create a persona matrix (C3): same charter + multiple personas → multiple parallel exploration sessions (same matrix_id).
 * Returns matrixId and all sessions in one shot (the frontend jumps to the matrix view to watch each session's progress).
 * The route must be registered before `/:id/live` — otherwise `/matrix/:id` would be swallowed by `/:id/live`.
 */
explorationsRoute.post('/matrix', async (req, res) => {
  const body = CreateMatrixBody.parse(req.body);
  if ((body.windowWidth === undefined) !== (body.windowHeight === undefined)) {
    throw new HttpError(400, 'window_required', 'windowWidth and windowHeight must be provided together');
  }
  const { projectId } = await assertVersionVisible(body.versionId, req.user!);
  const personas = [...new Set(body.personas)];
  const matrixId = randomUUID();
  const label = body.label?.trim() || `${personas.length} 人格矩阵`;
  const title = body.title?.trim() || body.charter.slice(0, 80);
  const inserted = await db
    .insert(explorationSessions)
    .values(
      personas.map((persona) => ({
        projectId,
        versionId: body.versionId,
        title,
        charter: body.charter,
        persona,
        startUrl: body.startUrl?.trim() || null,
        allowDestructive: body.allowDestructive,
        allowFaultInjection: body.allowFaultInjection,
        windowWidth: body.windowWidth ?? null,
        windowHeight: body.windowHeight ?? null,
        budgetTurns: body.budgetTurns ?? null,
        status: 'pending' as const,
        codeScopeStatus: 'pending' as const,
        matrixId,
        matrixLabel: label,
        matrixRole: persona,
        createdByUserId: req.user!.userId,
      })),
    )
    .returning();
  for (const row of inserted) await dispatchExploration(row.id);
  res.status(201).json({ matrixId, label, sessions: inserted });
});

/**
 * Matrix view: all sessions in the matrix + their findings (each finding carries crossSessionCount — ≥2 = discovered from multiple perspectives).
 * The intersection numbers are recomputed at wrap-up (S2); read-only here.
 */
explorationsRoute.get('/matrix/:matrixId', async (req, res) => {
  const matrixId = req.params.matrixId!;
  const sessions = await db
    .select()
    .from(explorationSessions)
    .where(eq(explorationSessions.matrixId, matrixId))
    .orderBy(asc(explorationSessions.createdAt));
  if (sessions.length === 0) throw new HttpError(404, 'not_found', 'matrix not found');
  await assertProjectVisible(sessions[0]!.projectId, req.user!);
  const findings = await db
    .select()
    .from(explorationFindings)
    .where(inArray(explorationFindings.sessionId, sessions.map((s) => s.id)))
    .orderBy(asc(explorationFindings.order));
  res.json({
    matrixId,
    label: sessions[0]!.matrixLabel,
    sessions: await attachCreators(sessions),
    findings,
  });
});

/**
 * Cancel matrix: set cancel_requested on **non-terminal** sessions in the matrix (same semantics as single-session cancel).
 * Terminal sessions are left unchanged (idempotent: repeated calls return ok).
 */
explorationsRoute.post('/matrix/:matrixId/cancel', async (req, res) => {
  const matrixId = req.params.matrixId!;
  const sessions = await db
    .select({ id: explorationSessions.id, projectId: explorationSessions.projectId })
    .from(explorationSessions)
    .where(eq(explorationSessions.matrixId, matrixId));
  if (sessions.length === 0) throw new HttpError(404, 'not_found', 'matrix not found');
  await assertProjectVisible(sessions[0]!.projectId, req.user!);
  const cancelled = await db
    .update(explorationSessions)
    .set({ cancelRequested: true, updatedAt: new Date() })
    .where(
      and(
        eq(explorationSessions.matrixId, matrixId),
        inArray(explorationSessions.status, ['pending', 'running']),
      ),
    )
    .returning({ id: explorationSessions.id });
  res.json({ ok: true, cancelled: cancelled.length });
});

/** Detail: session + findings (order ascending) + creator + session process (per-action trail of every step). */
explorationsRoute.get('/:id', async (req, res) => {
  const session = await loadSession(req.params.id!, req.user!);
  const findings = await db
    .select()
    .from(explorationFindings)
    .where(eq(explorationFindings.sessionId, session.id))
    .orderBy(asc(explorationFindings.order));
  const [withCreator] = await attachCreators([session]);
  // The session-level action-trail column holds the whole run's action sequence; older sessions lack this column's data, fall back to merging each finding's fragments.
  const steps = session.actionsTrail?.length ? session.actionsTrail : mergeExplorationTrails(findings);
  res.json({ ...withCreator, findings, steps });
});

/**
 * Cancel session: set cancel_requested=true. Idempotent — calling again on a terminal session still returns ok (no worker polls it anymore).
 * Cancelling during pending: once claimed, the runner goes straight to the fast wrap-up path without opening a browser.
 */
explorationsRoute.post('/:id/cancel', async (req, res) => {
  const session = await loadSession(req.params.id!, req.user!);
  await db
    .update(explorationSessions)
    .set({ cancelRequested: true, updatedAt: new Date() })
    .where(eq(explorationSessions.id, session.id));
  res.json({ ok: true });
});

/**
 * Delete session: findings cascade-delete; the screenshot directory is cleaned up along with it.
 * running/pending sessions are delete-blocked by default (the executor is still writing screenshots and findings into them);
 * but sessions with cancel_requested are allowed through — the executor will wrap up gracefully on its next polling round,
 * and its late writes are caught by FK/try-catch. Orphan sessions left by a dead executor process (API restart/crash)
 * would never reach wrap-up; without the exception they'd be stuck in running — neither deletable nor viewable.
 */
explorationsRoute.delete('/:id', async (req, res) => {
  const session = await loadSession(req.params.id!, req.user!);
  const live = session.status === 'running' || session.status === 'pending';
  if (live && !session.cancelRequested) {
    throw new HttpError(409, 'exploration_running', 'exploration session is still running');
  }
  const deleted = await db
    .delete(explorationSessions)
    .where(eq(explorationSessions.id, session.id))
    .returning({ id: explorationSessions.id });
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'exploration session not found');
  await removeExplorationScreenshots(session.id);
  res.json({ ok: true });
});

/**
 * Live view (MJPEG): the `exploration:<id>` source registered by the runner, connectable only while running.
 *  ?replay=1 replays this run's recording; &speed=N sets the replay speed; ?replay=meta probes whether the recording is still replayable.
 */
explorationsRoute.get('/:id/live', async (req, res) => {
  const session = await loadSession(req.params.id!, req.user!);
  if (req.query.replay === 'meta') return handleLiveReplayMeta(res, `exploration:${session.id}`);
  if (req.query.replay === '1') return handleLiveReplay(req, res, `exploration:${session.id}`, { speed: replaySpeedOf(req.query) });
  handleLiveView(req, res, `exploration:${session.id}`);
});

const ReviewBody = z.object({ decision: z.enum(['confirmed', 'dismissed']) });

const PromoteBody = z.object({
  groupId: z.string().uuid(),
  title: z.string().trim().min(1).max(200).optional(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
});

/** Fetch a finding and verify it belongs to this session (cross-session/missing both 404). */
async function loadFinding(sessionId: string, findingId: string) {
  const row = (await db.select().from(explorationFindings).where(eq(explorationFindings.id, findingId)))[0];
  if (!row || row.sessionId !== sessionId) throw new HttpError(404, 'not_found', 'finding not found');
  return row;
}

/**
 * Review a finding: confirm or dismiss.
 * Only pending is accepted — reviewing an already-reviewed finding returns 409 to avoid silently overwriting the review verdict.
 */
explorationsRoute.post('/:id/findings/:fid/review', async (req, res) => {
  const session = await loadSession(req.params.id!, req.user!);
  const body = ReviewBody.parse(req.body);
  const finding = await loadFinding(session.id, req.params.fid!);
  if (finding.status !== 'pending') {
    throw new HttpError(409, 'already_reviewed', 'finding is not pending');
  }
  const updated = (await db
    .update(explorationFindings)
    .set({ status: body.decision, reviewedBy: req.user!.userId, reviewedAt: new Date() })
    .where(eq(explorationFindings.id, finding.id))
    .returning())[0]!;
  res.json(updated);
});

/**
 * Promotion step source (2026-11-11 policy): prefer the platform action trail (ground truth, best-effort mechanical
 * DSL — click/fill/navigate map to compiled, unmappable actions stay pure NL); when the trail is unusable (old
 * sessions lack value/ms/key fields, all actions failed, or evidence-type actions were filtered) fall back to the
 * model's reproSteps (pure NL, pending AI compilation); if both are empty return [] (the route returns 400 on that).
 * Previously the model's reproSteps took priority — but it can hallucinate, its count may disagree with the
 * mechanical actions, and no DSL could be produced.
 */
function promoteStepsOf(finding: { reproSteps: unknown; actionsTrail: unknown }): Array<{ instruction: string; compiled: unknown[] | null }> {
  const trail = Array.isArray(finding.actionsTrail) ? finding.actionsTrail : [];
  const fromTrail = trailToCaseSteps(trail);
  if (fromTrail.length > 0) return fromTrail;
  const repro = Array.isArray(finding.reproSteps) ? finding.reproSteps : [];
  const fromModel = repro
    .map((s) => {
      const action = (s as { action?: unknown } | null)?.action;
      return typeof action === 'string' ? action.trim() : '';
    })
    .filter(Boolean);
  return fromModel.map((instruction) => ({ instruction, compiled: null }));
}

/**
 * Promote a confirmed finding into a case draft: steps prefer the platform action trail with a best-effort
 * mechanical mapping (click/fill/navigate → compiled DSL, replay doesn't go through AI); unmappable actions keep
 * instruction + compiled=null and are completed via the existing "compile-missing blocking + UI AI compile" flow.
 * The exploration side does no AI compilation (no real run, no acceptance) — the mechanical mapping is a zero-cost transformation, not compilation.
 */
explorationsRoute.post('/:id/findings/:fid/promote', async (req, res) => {
  const session = await loadSession(req.params.id!, req.user!);
  const body = PromoteBody.parse(req.body);
  const finding = await loadFinding(session.id, req.params.fid!);
  if (finding.status === 'promoted') {
    throw new HttpError(409, 'already_promoted', 'finding already promoted');
  }
  if (finding.status !== 'confirmed') {
    throw new HttpError(409, 'not_confirmed', 'finding must be confirmed before promotion');
  }
  const groupRow = (await db.select({ projectId: groups.projectId }).from(groups).where(eq(groups.id, body.groupId)))[0];
  if (!groupRow) throw new HttpError(404, 'not_found', 'group not found');
  if (groupRow.projectId !== session.projectId) {
    throw new HttpError(400, 'group_project_mismatch', 'group does not belong to this project');
  }
  const steps = promoteStepsOf(finding);
  if (steps.length === 0) {
    throw new HttpError(400, 'no_repro_steps', 'finding has no reproducible steps');
  }
  const created = await createCaseWithSteps({
    groupId: body.groupId,
    versionId: session.versionId,
    title: body.title?.trim() || finding.title,
    description: finding.description,
    priority: body.priority ?? finding.severity,
    steps,
  });
  await db
    .update(explorationFindings)
    .set({ status: 'promoted', promotedCaseId: created.id })
    .where(eq(explorationFindings.id, finding.id));
  res.status(201).json({ caseId: created.id, findingId: finding.id });
});
