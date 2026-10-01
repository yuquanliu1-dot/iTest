import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { testCases, testSteps, testAttachments, testSessions } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';
import { StepAction } from '@itest/shared';
import { createSession, getSession } from '../recorder/ws.js';
import { resolveCaseUrl } from '../lib/resolve-url.js';
import { compileAiStepsInPlace } from '../agent/aiStepCompile.js';
import { assertCaseVisible } from '../services/projectAccess.js';

export const recorderRoute = Router();

const CreateBody = z.object({
  caseId: z.string().uuid(),
  mode: z.enum(['fresh', 'append', 'resume', 'incognito']).default('fresh'),
  incognito: z.boolean().optional(),
  resumeFromOrder: z.number().int().positive().optional(),
});

recorderRoute.post('/sessions', async (req, res) => {
  const body = CreateBody.parse(req.body);
  const exists = await db.select().from(testCases).where(eq(testCases.id, body.caseId));
  if (exists.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  await assertCaseVisible(body.caseId, req.user!);
  if (body.mode === 'resume') {
    const steps = await db.select().from(testSteps).where(eq(testSteps.caseId, body.caseId));
    // resumeFromOrder 是第一条新步骤的 order；之前的步骤只做校验（回放由扩展侧驱动）。
    const upto = body.resumeFromOrder ?? steps.length + 1;
    const slice = steps.filter((s) => s.order < upto);
    for (const s of slice) {
      const a = (s.action ?? {}) as { kind?: string; fileId?: string };
      if (a.kind === 'upload') {
        if (!a.fileId) throw new HttpError(409, 'upload_unbound', `upload step #${s.order} has no fileId bound`);
        const att = await db.select().from(testAttachments).where(eq(testAttachments.id, a.fileId));
        if (att.length === 0) throw new HttpError(409, 'upload_missing', `attachment ${a.fileId} not found`);
      }
    }
  }
  const resolvedUrl = await resolveCaseUrl(exists[0]!);
  const session = createSession(body.caseId, {
    mode: body.mode,
    incognito: body.incognito ?? body.mode === 'incognito',
    resumeFromOrder: body.resumeFromOrder,
  });
  // Also persist the session row for audit
  const dbRow = await db
    .insert(testSessions)
    .values({
      caseId: body.caseId,
      mode: body.mode,
      incognito: body.incognito ?? body.mode === 'incognito',
      resumeFromOrder: body.resumeFromOrder ?? null,
    })
    .returning({ id: testSessions.id });
  session.dbSessionId = dbRow[0]!.id;
  res.json({
    sessionId: session.sessionId,
    wsToken: process.env.RECORDER_TOKEN_SECRET ?? 'dev-secret-change-me',
    wsUrl: `ws://127.0.0.1:${process.env.API_PORT ?? 54321}/recorder`,
    resolvedUrl,
    mode: body.mode,
  });
});

recorderRoute.post('/sessions/:id/finish', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) throw new HttpError(404, 'not_found', 'session not found');
  await assertCaseVisible(session.caseId, req.user!);
  session.ws?.close(1000, 'finished');
  await compileAiStepsInPlace(
    session.steps.map((s) => {
      const item = s as { action: unknown; url?: string };
      return { action: item.action, url: item.url };
    }),
  );
  let inserted = 0;
  const existing = await db.select().from(testSteps).where(eq(testSteps.caseId, session.caseId));
  let nextOrder = existing.length > 0 ? Math.max(...existing.map((s) => s.order)) + 1 : 1;
  for (const step of session.steps) {
    const item = step as { action: unknown; tabRef?: string; componentKind?: string };
    StepAction.parse(item.action);
    await db.insert(testSteps).values({
      caseId: session.caseId,
      order: nextOrder++,
      source: 'recorder',
      action: item.action as object,
      tabRef: item.tabRef ?? null,
      componentKind: item.componentKind ?? null,
    });
    inserted++;
  }
  if (session.tabs && session.tabs.length > 0 && session.dbSessionId) {
    await db.update(testSessions).set({ tabs: session.tabs }).where(eq(testSessions.id, session.dbSessionId));
  }
  res.json({ inserted });
});

recorderRoute.post('/sessions/:id/tab-events', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) throw new HttpError(404, 'not_found', 'session not found');
  const body = z.object({
    events: z.array(z.object({
      kind: z.enum(['opened', 'closed']),
      tabRef: z.string().min(1).max(64),
      title: z.string().optional(),
      url: z.string().optional(),
    })),
  }).parse(req.body);
  if (!session.tabs) session.tabs = [];
  session.tabs.push(...body.events);
  res.json({ count: session.tabs.length });
});