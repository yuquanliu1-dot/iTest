/**
 * 版本空间 AI 助手 HTTP+SSE 契约(react-pi 兼容子集),挂载于 /api/assistant。
 * 与 /api/pi(requirement 级)并列,只服务 kind='version' 线程。
 * 事件通道与 pi/router.ts 同源:session fanOut(含 emitThreadEvent 的 confirm_request)。
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { aiThreads } from '../../db/schema.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { assertVersionVisible } from '../../services/projectAccess.js';
import { sseHeaders, sseSend } from '../../sse/agentRunStream.js';
import type { AuthUser } from '../../services/auth.service.js';
import { readLlmConfig } from '../modelBridge.js';
import { resolveConfirmation } from './confirm.js';
import {
  cancelThread, ensureSpaceRecord, sendSpaceUserMessage, snapshotOfThread, subscribeThread, threadStatus,
} from './session.js';

export const spaceRoute = Router();

/** threadId → versionId;仅接受 kind='version'(requirement 线程归 /api/pi 管,这里一律 404)。 */
async function assertSpaceThreadVisible(threadId: string, user: AuthUser): Promise<string> {
  const row = (await db
    .select({ kind: aiThreads.kind, versionId: aiThreads.versionId })
    .from(aiThreads)
    .where(eq(aiThreads.id, threadId))
    .limit(1))[0];
  if (!row || row.kind !== 'version' || !row.versionId) throw new HttpError(404, 'not_found', 'thread not found');
  await assertVersionVisible(row.versionId, user);
  return row.versionId;
}

/** react-pi 契约:POST/GET threads 必须返回完整 PiThreadSnapshot;兜底空快照刻意无 seq(requirement 级 /api/pi 兜底带 legacy seq:0,勿同步)。 */
function threadSnapshotResponse(threadId: string): unknown {
  const live = snapshotOfThread(threadId);
  return live ?? { metadata: { id: threadId, status: 'idle', messageCount: 0 }, messages: [] };
}

spaceRoute.post('/threads', async (req, res) => {
  const body = req.body as { metadata?: { versionId?: string } };
  const versionId = body.metadata?.versionId;
  if (!versionId) throw new HttpError(400, 'bad_request', 'metadata.versionId required');
  await assertVersionVisible(versionId, req.user as AuthUser);
  // 每次调用新建一线程(一版本多线程);行先落库,LLM 未配置时 session 建不起来也照常返回快照;
  // 客户端重试可能留下无 session 的孤儿线程(可 GC),属预期行为
  const threadId = randomUUID();
  await db.insert(aiThreads).values({ id: threadId, kind: 'version', versionId, piThreadId: '' });
  try { await ensureSpaceRecord(threadId); } catch { /* LLM 未配置等;前端经 SSE/快照感知 */ }
  res.json(threadSnapshotResponse(threadId));
});

spaceRoute.get('/threads', async (req, res) => {
  const raw = req.query.versionId;
  const versionId = typeof raw === 'string' ? raw : '';
  if (!versionId) throw new HttpError(400, 'bad_request', 'versionId query required');
  await assertVersionVisible(versionId, req.user as AuthUser);
  const rows = await db
    .select({ id: aiThreads.id, title: aiThreads.title, createdAt: aiThreads.createdAt, updatedAt: aiThreads.updatedAt })
    .from(aiThreads)
    .where(and(eq(aiThreads.kind, 'version'), eq(aiThreads.versionId, versionId)))
    .orderBy(desc(aiThreads.updatedAt))
    .limit(20);
  res.json(rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: threadStatus(row.id) ?? 'idle',
    createdAt: row.createdAt?.toISOString(),
    updatedAt: row.updatedAt?.toISOString(),
  })));
});

spaceRoute.get('/threads/:id', async (req, res) => {
  // assertSpaceThreadVisible 已保证 kind='version' 且行存在(否则 404)
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  res.json(threadSnapshotResponse(req.params.id!));
});

spaceRoute.post('/threads/:id/messages', async (req, res) => {
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  const body = req.body as { input?: { content?: string } };
  const content = body.input?.content ?? '';
  // 不阻塞响应:先回 204,后台 ensure + 派发(与 requirement 流一致;LLM 未配置时静默,前端经快照感知)
  void (async () => {
    try {
      await ensureSpaceRecord(req.params.id!);
      await sendSpaceUserMessage(req.params.id!, content);
    } catch { /* ignore */ }
  })();
  res.status(204).end();
});

spaceRoute.post('/threads/:id/cancel', async (req, res) => {
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  cancelThread(req.params.id!);
  res.status(204).end();
});

spaceRoute.post('/threads/:id/confirm', async (req, res) => {
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  const body = req.body as { confirmId?: string; approved?: boolean };
  if (!body.confirmId || typeof body.approved !== 'boolean') {
    throw new HttpError(400, 'bad_request', 'confirmId and approved are required');
  }
  if (!resolveConfirmation(body.confirmId, body.approved)) {
    throw new HttpError(404, 'not_found', 'confirmation not found or expired');
  }
  res.status(204).end();
});

spaceRoute.get('/models', async (_req, res) => {
  const cfg = await readLlmConfig();
  if (!cfg) { res.json([]); return; }
  res.json([{ provider: cfg.provider, modelId: cfg.model }]);
});

spaceRoute.get('/threads/:id/events', async (req, res) => {
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  sseHeaders(res);
  try {
    const send = (e: unknown) => sseSend(res, e as unknown as Parameters<typeof sseSend>[1]);
    // subscribeThread 自带 snapshot(无活跃 session 时发合法空快照);
    // confirm_request / 舞台事件经 emitThreadEvent 走同一 listeners 通道。
    const unsub = subscribeThread(req.params.id!, send, { includeSnapshot: true });
    req.on('close', () => { unsub(); });
  } catch {
    res.end();
  }
});
