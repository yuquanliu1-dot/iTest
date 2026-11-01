/**
 * R3.5 失败教训路由（requireManager）：教训列表 + 人工退役。
 * assistant_failure_signals 不暴露路由（内部采集层）。
 */
import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { HttpError } from '../../middleware/errorHandler.js';
import { db } from '../../db/client.js';
import { assistantFailureLessons } from '../../db/schema.js';

const router = Router();
const STATUSES = ['active', 'resolved', 'retired'] as const;

router.get('/', async (req, res) => {
  const raw = req.query.status;
  if (raw !== undefined && (typeof raw !== 'string' || !STATUSES.includes(raw as never))) {
    throw new HttpError(400, 'bad_status', `status 仅支持 ${STATUSES.join('/')}`);
  }
  const status = (typeof raw === 'string' ? raw : 'active') as (typeof STATUSES)[number];
  const rows = await db.select().from(assistantFailureLessons)
    .where(eq(assistantFailureLessons.status, status))
    .orderBy(desc(assistantFailureLessons.createdAt)).limit(200);
  res.json(rows);
});

router.post('/:id/retire', async (req, res) => {
  const r = await db.update(assistantFailureLessons)
    .set({ status: 'retired', updatedAt: new Date() })
    .where(and(eq(assistantFailureLessons.id, req.params.id!), eq(assistantFailureLessons.status, 'active')))
    .returning({ id: assistantFailureLessons.id });
  if (r.length === 0) throw new HttpError(404, 'not_found', '教训不存在或不在 active 状态');
  res.json({ ok: true });
});

export default router;
