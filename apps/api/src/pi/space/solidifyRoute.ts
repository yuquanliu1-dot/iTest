/**
 * R3 solidification pipeline routes (requireManager). scan is fire-and-forget: returns the batch id immediately,
 * distillation runs inline (same as R2's trajectoryQueue), the frontend polls batch status; errors are recorded on the batch, never in the response.
 */
import { Router } from 'express';
import { and, count, desc, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { parsePaging } from '../../lib/pagination.js';
import { HttpError } from '../../middleware/errorHandler.js';
import type { AuthUser } from '../../services/auth.service.js';
import { db } from '../../db/client.js';
import { assistantSolidifyBatches, assistantSolidifyProposals } from '../../db/schema.js';
import { approveProposal, rejectProposal } from './solidifyApply.js';
import { runSolidifyScan, startSolidifyScan } from './solidifyService.js';

const router = Router();

router.post('/scan', async (req, res) => {
  const user = req.user as AuthUser;
  const id = await startSolidifyScan(user.userId);
  void runSolidifyScan(id).catch(() => {}); // inline fire-and-forget; failures are recorded on the batch
  res.status(202).json({ id });
});

router.get('/batches', async (req, res) => {
  const q = req.query;
  const { page, limit } = parsePaging(q as Record<string, unknown>);
  const conds: SQL[] = [];
  if (typeof q.status === 'string' && q.status) conds.push(eq(assistantSolidifyBatches.status, q.status));
  const where = conds.length > 0 ? and(...conds) : undefined;
  const [rows, totalRows] = await Promise.all([
    db.select().from(assistantSolidifyBatches)
      .where(where)
      // createdAt is not unique → append id as tiebreaker, otherwise pages repeat/skip rows
      .orderBy(desc(assistantSolidifyBatches.createdAt), desc(assistantSolidifyBatches.id))
      .limit(limit).offset((page - 1) * limit),
    db.select({ count: count() }).from(assistantSolidifyBatches).where(where),
  ]);
  res.json({ items: rows, total: Number(totalRows[0]?.count ?? 0), page, limit });
});

router.get('/proposals', async (req, res) => {
  const q = req.query;
  const { batchId, status } = q as { batchId?: string; status?: string };
  const { page, limit } = parsePaging(q as Record<string, unknown>);
  const conds: SQL[] = [];
  if (batchId) conds.push(eq(assistantSolidifyProposals.batchId, batchId));
  if (status) conds.push(eq(assistantSolidifyProposals.status, status));
  const where = conds.length > 0 ? and(...conds) : undefined;
  const [rows, totalRows] = await Promise.all([
    db.select().from(assistantSolidifyProposals)
      .where(where)
      // Pending review first (the human approval surface): pending comes first, the rest by creation time descending; id as fallback against cross-page duplicates
      .orderBy(
        sql`CASE WHEN ${assistantSolidifyProposals.status} = 'pending' THEN 0 ELSE 1 END`,
        desc(assistantSolidifyProposals.createdAt),
        desc(assistantSolidifyProposals.id),
      )
      .limit(limit).offset((page - 1) * limit),
    db.select({ count: count() }).from(assistantSolidifyProposals).where(where),
  ]);
  res.json({ items: rows, total: Number(totalRows[0]?.count ?? 0), page, limit });
});

router.get('/proposals/:id', async (req, res) => {
  const row = (await db.select().from(assistantSolidifyProposals)
    .where(eq(assistantSolidifyProposals.id, req.params.id)).limit(1))[0];
  if (!row) throw new HttpError(404, 'not_found', '提案不存在');
  res.json(row);
});

const ApproveBody = z.object({ retireIds: z.array(z.string().uuid()).max(50).default([]) });

router.post('/proposals/:id/approve', async (req, res) => {
  const user = req.user as AuthUser;
  const parsed = ApproveBody.safeParse(req.body ?? {});
  if (!parsed.success) throw new HttpError(400, 'invalid_body', '请求体不合法');
  await approveProposal(user.userId, String(req.params.id), parsed.data.retireIds);
  res.json({ ok: true });
});

router.post('/proposals/:id/reject', async (req, res) => {
  const user = req.user as AuthUser;
  await rejectProposal(user.userId, String(req.params.id));
  res.json({ ok: true });
});

export default router;
