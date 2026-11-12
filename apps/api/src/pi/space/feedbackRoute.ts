/**
 * Version-space assistant "user feedback" HTTP endpoints (Phase 1: collect only, no consumption):
 *   POST /assistant/feedback   submit a piece of feedback (👍/👎 + optional text)
 *   GET  /assistant/feedback?threadId=  list the current user's feedback on that thread (frontend marks "submitted")
 *
 * Why feedback must carry its own body snapshot: messages live fully in memory
 * (SessionManager.inMemory), so the backend cannot look them up retroactively; and the pi
 * projection layer's message id is just a positional index (pi-msg:<index>), unreproducible
 * after a restart.
 * So excerpt is the only reliable basis for retrospection; anchor is a clue only.
 *
 * Permissions: submitting feedback is a normal user action, **deliberately without requireManager**
 * (same tier as stageRoute); thread visibility is backed by assertSpaceThreadVisible, with a
 * uniform cross-org 404 preventing existence probing.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { Router } from 'express';
import { db } from '../../db/client.js';
import { aiAssistantFeedback, projects, users } from '../../db/schema.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { requireManager } from '../../middleware/auth.js';
import { resolveVersionProjectId, visibleProjectIds } from '../../services/projectAccess.js';
import type { AuthUser } from '../../services/auth.service.js';
import { assertSpaceThreadVisible } from './router.js';

export const feedbackRoute = Router();

/** Body snapshot cap: enough to see the context, without bloating the feedback table into a chat log. */
const EXCERPT_LIMIT = 500;
const COMMENT_LIMIT = 2000;

interface CreateBody {
  threadId?: string;
  role?: string;
  messageAnchor?: string;
  messageIndex?: number;
  messageExcerpt?: string;
  messageAt?: string;
  sentiment?: string;
  comment?: string;
}

feedbackRoute.post('/feedback', async (req, res) => {
  const body = (req.body ?? {}) as CreateBody;
  const threadId = typeof body.threadId === 'string' ? body.threadId : '';
  if (!threadId) throw new HttpError(400, 'bad_request', 'threadId required');
  if (body.sentiment !== 'positive' && body.sentiment !== 'negative') {
    throw new HttpError(400, 'bad_request', 'sentiment must be positive or negative');
  }
  // Thread visibility (also returns versionId); invisible/not-found both get a uniform 404.
  const versionId = await assertSpaceThreadVisible(threadId, req.user as AuthUser);
  const projectId = await resolveVersionProjectId(versionId);
  if (!projectId) throw new HttpError(500, 'invariant', 'version project missing');

  const userId = (req.user as { userId?: string } | undefined)?.userId ?? null;
  await db.insert(aiAssistantFeedback).values({
    threadId,
    versionId,
    projectId,
    userId,
    role: body.role === 'user' ? 'user' : 'assistant',
    messageAnchor: typeof body.messageAnchor === 'string' ? body.messageAnchor.slice(0, 64) : null,
    messageIndex: Number.isInteger(body.messageIndex) ? body.messageIndex! : null,
    messageExcerpt: typeof body.messageExcerpt === 'string' ? body.messageExcerpt.slice(0, EXCERPT_LIMIT) : null,
    messageAt: body.messageAt ? new Date(body.messageAt) : null,
    sentiment: body.sentiment,
    comment: typeof body.comment === 'string' ? body.comment.slice(0, COMMENT_LIMIT) : null,
  });
  res.status(204).end();
});

feedbackRoute.get('/feedback', async (req, res) => {
  const raw = req.query.threadId;
  const threadId = typeof raw === 'string' ? raw : '';
  if (!threadId) { res.json([]); return; }
  await assertSpaceThreadVisible(threadId, req.user as AuthUser);
  const userId = (req.user as { userId?: string } | undefined)?.userId ?? null;
  // Return only what the current user submitted: the "submitted" marker on a bubble is personal
  // state, not collaborative state. When userId is empty (should not happen — global requireAuth
  // guarantees it) return an empty list, rather than using userId IS NULL as a condition — that
  // would count others' anonymous feedback as one's own.
  if (!userId) { res.json([]); return; }
  const rows = await db
    .select({
      id: aiAssistantFeedback.id,
      messageAnchor: aiAssistantFeedback.messageAnchor,
      messageIndex: aiAssistantFeedback.messageIndex,
      sentiment: aiAssistantFeedback.sentiment,
      createdAt: aiAssistantFeedback.createdAt,
    })
    .from(aiAssistantFeedback)
    .where(and(eq(aiAssistantFeedback.threadId, threadId), eq(aiAssistantFeedback.userId, userId)));
  res.json(rows.map((r) => ({
    id: r.id,
    messageAnchor: r.messageAnchor,
    messageIndex: r.messageIndex,
    sentiment: r.sentiment,
    createdAt: r.createdAt?.toISOString(),
  })));
});

/**
 * Admin feedback list (for the settings page). requireManager is attached to the **individual
 * route**, not the whole feedbackRoute — the POST/GET above are normal user actions, and putting
 * requireManager on the whole router would lock out submitting feedback too.
 *
 * Cross-org isolation: returns only feedback under projects visible to the caller
 * (visibleProjectIds subquery), same policy as guidesRoute.
 */
feedbackRoute.get('/feedback/all', requireManager, async (req, res) => {
  const sentiment = typeof req.query.sentiment === 'string' ? req.query.sentiment : '';
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  const conds = [inArray(aiAssistantFeedback.projectId, await visibleProjectIds(req.user as AuthUser))];
  if (sentiment === 'positive' || sentiment === 'negative') {
    conds.push(eq(aiAssistantFeedback.sentiment, sentiment));
  }
  if (projectId) conds.push(eq(aiAssistantFeedback.projectId, projectId));

  // limit capped at 200: even a full collection-phase dump must not let the admin page swallow tens of thousands of rows at once.
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const rows = await db
    .select({
      id: aiAssistantFeedback.id,
      threadId: aiAssistantFeedback.threadId,
      versionId: aiAssistantFeedback.versionId,
      projectId: aiAssistantFeedback.projectId,
      userId: aiAssistantFeedback.userId,
      sentiment: aiAssistantFeedback.sentiment,
      messageExcerpt: aiAssistantFeedback.messageExcerpt,
      comment: aiAssistantFeedback.comment,
      createdAt: aiAssistantFeedback.createdAt,
    })
    .from(aiAssistantFeedback)
    .where(and(...conds))
    .orderBy(desc(aiAssistantFeedback.createdAt))
    .limit(limit)
    .offset(offset);
  const countRows = await db
    .select({ count: sql<number>`count(*)` })
    .from(aiAssistantFeedback)
    .where(and(...conds));
  const total = Number(countRows[0]?.count ?? 0);

  // Bring the username along: the admin page needs "who submitted it", sparing the frontend another round of user lookups.
  const names = new Map<string, string>();
  const userIds = rows.map((r) => r.userId).filter((v): v is string => !!v);
  if (userIds.length) {
    for (const u of await db.select({ id: users.id, username: users.username, displayName: users.displayName })
      .from(users).where(inArray(users.id, userIds))) {
      names.set(u.id, u.displayName || u.username);
    }
  }
  res.json({
    total,
    rows: rows.map((r) => ({
      id: r.id,
      threadId: r.threadId,
      versionId: r.versionId,
      projectId: r.projectId,
      sentiment: r.sentiment,
      messageExcerpt: r.messageExcerpt,
      comment: r.comment,
      authorName: r.userId ? names.get(r.userId) ?? null : null,
      createdAt: r.createdAt?.toISOString(),
    })),
  });
});

/** Candidate projects for admin filtering (same visibility semantics as the list). */
feedbackRoute.get('/feedback/projects', requireManager, async (req, res) => {
  const ids = await visibleProjectIds(req.user as AuthUser);
  if (!ids.length) { res.json([]); return; }
  const rows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, ids));
  res.json(rows);
});
