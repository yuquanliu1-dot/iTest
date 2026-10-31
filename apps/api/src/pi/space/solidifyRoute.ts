/**
 * R3 固化管线路由（requireManager）。scan 是 fire-and-forget：立即返回批次 id，
 * 蒸馏 inline 跑（R2 trajectoryQueue 同款），前端轮询批次状态；错误记在批次上不进响应。
 */
import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
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
  void runSolidifyScan(id).catch(() => {}); // inline fire-and-forget；失败已记批次
  res.status(202).json({ id });
});

router.get('/batches', async (_req, res) => {
  const rows = await db.select().from(assistantSolidifyBatches)
    .orderBy(desc(assistantSolidifyBatches.createdAt)).limit(50);
  res.json(rows);
});

router.get('/proposals', async (req, res) => {
  const { batchId, status } = req.query as { batchId?: string; status?: string };
  const conds = [];
  if (batchId) conds.push(eq(assistantSolidifyProposals.batchId, batchId));
  if (status) conds.push(eq(assistantSolidifyProposals.status, status));
  const rows = await db.select().from(assistantSolidifyProposals)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(assistantSolidifyProposals.createdAt)).limit(200);
  res.json(rows);
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
