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
import { logger } from '../../logger.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { assertVersionVisible } from '../../services/projectAccess.js';
import { sseHeaders, sseSend } from '../../sse/agentRunStream.js';
import type { AuthUser } from '../../services/auth.service.js';
import { readLlmConfig } from '../modelBridge.js';
import { resolveConfirmation } from './confirm.js';
import {
  cancelThread, ensureSpaceRecord, sendSpaceUserMessage, snapshotOfThread, spaceRepoIssue, subscribeThread, threadStatus,
} from './session.js';
import type { ThreadSnapshot } from './session.js';

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
function threadSnapshotResponse(threadId: string): ThreadSnapshot {
  const live = snapshotOfThread(threadId);
  return live ?? { metadata: { id: threadId, status: 'idle', messageCount: 0 }, messages: [] };
}

spaceRoute.post('/threads', async (req, res) => {
  const body = req.body as { metadata?: { versionId?: string } };
  const versionId = body.metadata?.versionId;
  if (!versionId) throw new HttpError(400, 'bad_request', 'metadata.versionId required');
  await assertVersionVisible(versionId, req.user as AuthUser);
  // 每次调用新建一线程(一版本多线程)。初始化失败(LLM 未配置等)→ 删行并透出错误,
  // 前端引导设置页;repo 不可用不阻断(session 照常建,原因经 lastError 透出)。
  const threadId = randomUUID();
  await db.insert(aiThreads).values({ id: threadId, kind: 'version', versionId, piThreadId: '' });
  try {
    await ensureSpaceRecord(threadId);
  } catch (e) {
    logger.error({ err: e, threadId, versionId }, 'space thread init failed');
    await db.delete(aiThreads).where(eq(aiThreads.id, threadId));
    if (e instanceof HttpError) throw e;
    throw new HttpError(500, 'session_init_failed', e instanceof Error ? e.message : '会话初始化失败');
  }
  const snap: ThreadSnapshot & { lastError?: string } = threadSnapshotResponse(threadId);
  const issue = spaceRepoIssue(threadId);
  if (issue) snap.lastError = `仓库暂不可用:${issue};对话可用,repo 类工具在修复仓库配置前会失败`;
  res.json(snap);
});

spaceRoute.get('/threads', async (req, res) => {
  const raw = req.query.versionId;
  const versionId = typeof raw === 'string' ? raw : '';
  // 无 versionId → 空列表(react-pi 运行时的线程列表机制按 Pi 契约不带参调用;
  // 页面级列表始终带 versionId)。不越权返回跨版本数据。
  if (!versionId) { res.json([]); return; }
  await assertVersionVisible(versionId, req.user as AuthUser);
  const rows = await db
    .select({ id: aiThreads.id, title: aiThreads.title, createdAt: aiThreads.createdAt, updatedAt: aiThreads.updatedAt })
    .from(aiThreads)
    .where(and(eq(aiThreads.kind, 'version'), eq(aiThreads.versionId, versionId)))
    .orderBy(desc(aiThreads.updatedAt))
    .limit(20);
  // 只列出确有会话记录的线程:消息全内存(SessionManager.inMemory),从未发过消息
  // 或记录已随进程重启丢失的线程不进下拉框(前端对当前不在列表的 threadId 有占位选项)。
  const withRecords = rows.filter((row) => (snapshotOfThread(row.id)?.metadata.messageCount ?? 0) > 0);
  res.json(withRecords.map((row) => ({
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
  // close 句柄先于 ensure 注册:建 session 可能耗时数十秒,期间客户端断开时
  // close 事件已触发过、之后再注册的 unsub 永远不会执行 → 监听器泄漏。
  let closed = false;
  let unsub: (() => void) | null = null;
  req.on('close', () => { closed = true; unsub?.(); });
  // 订阅前先确保 session 已构建:SSE 早于首条消息时若无 record,listener 会注册到
  // noop 上,后续 confirm_request/stage 全丢;ensure 幂等单飞,已有缓存直接返回。
  // 失败(LLM 未配置等)保留空快照语义,不中断连接。
  try { await ensureSpaceRecord(req.params.id!); } catch { /* 线程无法活跃,仍可接收快照 */ }
  if (closed) return;
  try {
    const send = (e: unknown) => sseSend(res, e as unknown as Parameters<typeof sseSend>[1]);
    // subscribeThread 自带 snapshot(无活跃 session 时发合法空快照);
    // confirm_request / 舞台事件经 emitThreadEvent 走同一 listeners 通道。
    // subscribeThread 同步返回 unsub:自上方的 closed 检查到赋值之间无 await,无竞态窗口。
    unsub = subscribeThread(req.params.id!, send, { includeSnapshot: true });
  } catch {
    res.end();
  }
});
