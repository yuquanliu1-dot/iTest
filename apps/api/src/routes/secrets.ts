import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { testCases, testSteps } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { decrypt } from '../lib/secret-crypto.js';

export const secretsRoute = Router();

const TOKEN = process.env.RECORDER_TOKEN_SECRET ?? 'dev-secret-change-me';

secretsRoute.get('/:caseId/steps/secrets/:stepId', async (req, res) => {
  const auth = (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (auth !== TOKEN) throw new HttpError(403, 'forbidden', 'recorder token required');
  const caseRow = await db.select().from(testCases).where(eq(testCases.id, req.params.caseId));
  if (caseRow.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  const rows = await db.select().from(testSteps).where(eq(testSteps.id, req.params.stepId));
  const step = rows[0];
  if (!step || step.caseId !== req.params.caseId) throw new HttpError(404, 'not_found', 'step not found');
  if (!step.sensitive || !step.secretCiphertext || !step.secretIv || !step.secretTag) {
    throw new HttpError(422, 'not_sensitive', 'step has no encrypted secret');
  }
  const value = decrypt({
    ciphertext: Buffer.from(step.secretCiphertext, 'base64'),
    iv: Buffer.from(step.secretIv, 'base64'),
    tag: Buffer.from(step.secretTag, 'base64'),
  });
  res.json({ value });
});
