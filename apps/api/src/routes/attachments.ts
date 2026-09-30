import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { testCases, testAttachments } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { persistUpload, uploadMaxBytes, ensureUploadDir } from '../lib/attachments.js';

export const attachmentsRoute = Router();

attachmentsRoute.post('/:caseId/attachments', async (req, res) => {
  const buf = req.body as Buffer;
  if (!Buffer.isBuffer(buf)) throw new HttpError(400, 'bad_request', 'expected octet-stream body');
  const max = uploadMaxBytes();
  if (buf.length > max) throw new HttpError(413, 'too_large', `file exceeds ${max} bytes`);
  const exists = await db.select().from(testCases).where(eq(testCases.id, req.params.caseId));
  if (exists.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  const originalName = (req.header('x-filename') ?? 'upload.bin').slice(0, 200);
  const mime = req.header('content-type') ?? null;

  await ensureUploadDir();
  const { sha256, storedPath, size } = await persistUpload(buf);

  // Same sha256 globally deduped
  const existing = await db.select().from(testAttachments).where(eq(testAttachments.sha256, sha256));
  if (existing.length > 0) {
    const row = existing[0]!;
    res.json({ id: row.id, sha256, originalName: row.originalName, size: row.size });
    return;
  }
  const inserted = await db
    .insert(testAttachments)
    .values({
      caseId: req.params.caseId,
      originalName,
      mime,
      size,
      sha256,
      storedPath,
    })
    .returning();
  res.json({ id: inserted[0]!.id, sha256, originalName, size });
});
