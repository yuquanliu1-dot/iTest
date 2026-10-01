import { Router } from 'express';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { testCases, testAttachments, groups } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { persistUpload, uploadMaxBytes, ensureUploadDir } from '../lib/attachments.js';
import { assertProjectVisible } from '../services/projectAccess.js';

export const attachmentsRoute = Router();

attachmentsRoute.post('/:caseId/attachments', async (req, res) => {
  const buf = req.body as Buffer;
  if (!Buffer.isBuffer(buf)) throw new HttpError(400, 'bad_request', 'expected octet-stream body');
  const max = uploadMaxBytes();
  if (buf.length > max) throw new HttpError(413, 'too_large', `file exceeds ${max} bytes`);
  const exists = await db.select().from(testCases).where(eq(testCases.id, req.params.caseId));
  if (exists.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  const groupId = exists[0]!.groupId;
  const g = (await db.select().from(groups).where(eq(groups.id, groupId)))[0];
  if (!g) throw new HttpError(404, 'not_found', 'group not found');
  const projectId = g.projectId;
  await assertProjectVisible(projectId, req.user!);
  const originalName = (req.header('x-filename') ?? 'upload.bin').slice(0, 200);
  const mime = req.header('content-type') ?? null;

  await ensureUploadDir();
  const { sha256, storedPath, size } = await persistUpload(buf);

  // Per-project dedup; same sha256 in different projects yields distinct records.
  const existing = await db
    .select()
    .from(testAttachments)
    .where(and(eq(testAttachments.sha256, sha256), eq(testAttachments.projectId, projectId)));
  if (existing.length > 0) {
    const row = existing[0]!;
    res.json({ id: row.id, sha256, originalName: row.originalName, size: row.size, mime: row.mime, createdAt: row.createdAt });
    return;
  }
  const inserted = await db
    .insert(testAttachments)
    .values({
      caseId: req.params.caseId,
      projectId,
      originalName,
      mime,
      size,
      sha256,
      storedPath,
    })
    .returning();
  const row = inserted[0]!;
  res.json({ id: row.id, sha256, originalName: row.originalName, size: row.size, mime: row.mime, createdAt: row.createdAt });
});

const ATTACHMENT_LIST_LIMIT = 200;

/** 列出本 project 已上传的全部附件；当前 case 的附件优先置顶。最新优先。 */
attachmentsRoute.get('/:caseId/attachments', async (req, res) => {
  const exists = await db.select().from(testCases).where(eq(testCases.id, req.params.caseId));
  if (exists.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  const groupId = exists[0]!.groupId;
  const g = (await db.select().from(groups).where(eq(groups.id, groupId)))[0];
  if (!g) throw new HttpError(404, 'not_found', 'group not found');
  const projectId = g.projectId;
  await assertProjectVisible(projectId, req.user!);
  const rows = await db
    .select({
      id: testAttachments.id,
      originalName: testAttachments.originalName,
      mime: testAttachments.mime,
      size: testAttachments.size,
      sha256: testAttachments.sha256,
      createdAt: testAttachments.createdAt,
      caseId: testAttachments.caseId,
    })
    .from(testAttachments)
    .where(eq(testAttachments.projectId, projectId))
    .orderBy(sql`CASE WHEN ${testAttachments.caseId} = ${req.params.caseId} THEN 0 ELSE 1 END`, sql`${testAttachments.createdAt} DESC`)
    .limit(ATTACHMENT_LIST_LIMIT);
  res.json(
    rows.map((r) => ({
      id: r.id,
      originalName: r.originalName,
      mime: r.mime,
      size: r.size,
      sha256: r.sha256,
      createdAt: r.createdAt,
    })),
  );
});
