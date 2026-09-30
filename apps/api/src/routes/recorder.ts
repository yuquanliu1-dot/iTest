import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { testCases, testSteps } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';
import { StepAction } from '@itest/shared';
import { createSession, getSession } from '../recorder/ws.js';
import { resolveCaseUrl } from '../lib/resolve-url.js';
import { compileAiStepsInPlace } from '../agent/aiStepCompile.js';

export const recorderRoute = Router();

const CreateBody = z.object({ caseId: z.string().uuid() });

recorderRoute.post('/sessions', async (req, res) => {
  const body = CreateBody.parse(req.body);
  const exists = await db.select().from(testCases).where(eq(testCases.id, body.caseId));
  if (exists.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  const resolvedUrl = await resolveCaseUrl(exists[0]!);
  const session = createSession(body.caseId);
  res.json({
    sessionId: session.sessionId,
    wsToken: process.env.RECORDER_TOKEN_SECRET ?? 'dev-secret-change-me',
    wsUrl: `ws://127.0.0.1:${process.env.API_PORT ?? 54321}/recorder`,
    resolvedUrl,
  });
});

recorderRoute.post('/sessions/:id/finish', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) throw new HttpError(404, 'not_found', 'session not found');
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
    const action = (step as { action: unknown }).action;
    StepAction.parse(action);
    await db.insert(testSteps).values({
      caseId: session.caseId,
      order: nextOrder++,
      source: 'recorder',
      action: action as object,
    });
    inserted++;
  }
  res.json({ inserted });
});
