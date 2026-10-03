/**
 * @assistant-ui/react-pi 0.0.25 HTTP + SSE wire contract.
 * 端点：threads 增查、messages、events(SSE)、cancel、models；其他 501。
 */
import { Router, type Request } from 'express';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { aiThreads, requirements } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { assertProjectVisible, visibleProjectIds } from '../services/projectAccess.js';
import { sseHeaders, sseSend } from '../sse/agentRunStream.js';
import type { AuthUser } from '../services/auth.service.js';
import {
  cancelThread, ensureRecord, sendUserMessage, snapshotOfThread, subscribeThread, threadStatus,
} from './session.js';
import { subscribeWorkspace } from './bus.js';
import { readLlmConfig } from './modelBridge.js';
import * as ws from './workspace.js';

export const piRoute = Router();

/** 解析 threadId → requirementId；不存在 → 404。 */
async function resolveRequirementForThread(threadId: string): Promise<string> {
  const rows = await db.select({ requirementId: aiThreads.requirementId }).from(aiThreads).where(eq(aiThreads.id, threadId)).limit(1);
  const rid = rows[0]?.requirementId;
  if (!rid) throw new HttpError(404, 'not_found', 'thread not found');
  const r = (await db.select({ projectId: requirements.projectId }).from(requirements).where(eq(requirements.id, rid)).limit(1))[0];
  if (!r) throw new HttpError(404, 'not_found', 'requirement not found');
  return r.projectId;
}

async function assertThreadVisible(threadId: string, user: AuthUser): Promise<void> {
  const pid = await resolveRequirementForThread(threadId);
  await assertProjectVisible(pid, user);
}

/** react-pi 契约：POST /threads 必须返回完整 PiThreadSnapshot。 */
function threadSnapshotResponse(threadId: string): unknown {
  const live = snapshotOfThread(threadId);
  return live ?? { metadata: { id: threadId, status: 'idle', messageCount: 0 }, messages: [], seq: 0 };
}

piRoute.post('/threads', async (req, res) => {
  const body = req.body as { metadata?: { requirementId?: string } };
  const rid = body.metadata?.requirementId;
  if (!rid) throw new HttpError(400, 'bad_request', 'metadata.requirementId required');
  const r = (await db.select({ projectId: requirements.projectId }).from(requirements).where(eq(requirements.id, rid)).limit(1))[0];
  if (!r) throw new HttpError(404, 'not_found', 'requirement not found');
  await assertProjectVisible(r.projectId, req.user as AuthUser);
  // ensureRecord 内部会调 factory 建 session，未配置 LLM 时抛错；但 ai_threads 行在抛错前已 INSERT，
  // 契约要求始终返回 thread snapshot，前端用 id 即可订阅 SSE。
  let threadId: string;
  try {
    const rec = await ensureRecord(rid);
    threadId = rec.threadId;
  } catch {
    const row = (await db.select({ id: aiThreads.id }).from(aiThreads).where(eq(aiThreads.requirementId, rid)).limit(1))[0];
    if (!row) throw new HttpError(500, 'internal_error', 'failed to create thread');
    threadId = row.id;
  }
  res.json(threadSnapshotResponse(threadId));
});

piRoute.get('/threads', async (req, res) => {
  // 只返回用户可见项目下的线程（可见性从项目维度判定）
  const visiblePids = await visibleProjectIds(req.user as AuthUser);
  if (visiblePids.length === 0) { res.json([]); return; }
  const rows = await db
    .select({ id: aiThreads.id, createdAt: aiThreads.createdAt, updatedAt: aiThreads.updatedAt })
    .from(aiThreads)
    .innerJoin(requirements, eq(aiThreads.requirementId, requirements.id))
    .where(inArray(requirements.projectId, visiblePids));
  res.json(rows.map((row) => ({
    id: row.id,
    status: threadStatus(row.id) ?? 'idle',
    createdAt: row.createdAt?.toISOString(),
    updatedAt: row.updatedAt?.toISOString(),
  })));
});

piRoute.get('/threads/:id', async (req, res) => {
  await assertThreadVisible(req.params.id!, req.user as AuthUser);
  const rows = await db.select({ id: aiThreads.id }).from(aiThreads).where(eq(aiThreads.id, req.params.id!)).limit(1);
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'thread not found');
  res.json(threadSnapshotResponse(req.params.id!));
});

piRoute.post('/threads/:id/messages', async (req, res) => {
  await assertThreadVisible(req.params.id!, req.user as AuthUser);
  const ridRow = (await db.select({ requirementId: aiThreads.requirementId }).from(aiThreads).where(eq(aiThreads.id, req.params.id!)).limit(1))[0];
  if (!ridRow) throw new HttpError(404, 'not_found', 'thread not found');
  // 不阻塞响应：先回 204，再后台 ensureRecord + 派发消息；
  // ensureRecord 在 LLM 未配置时会抛错，我们 swallow 后让上层 UI 通过 SSE 提示。
  const body = req.body as { input?: { content?: string }; metadata?: { contextMode?: 'repo' | 'page' | 'auto' } };
  const content = body.input?.content ?? '';
  const contextMode = body.metadata?.contextMode ?? 'auto';
  void (async () => {
    try {
      await ws.recordContextMode(ridRow.requirementId, contextMode);
      await ensureRecord(ridRow.requirementId, { contextMode });
      await sendUserMessage(req.params.id!, { content });
    } catch {
      // 配置缺失或线程未就绪：忽略；前端通过 SSE/快照可见 status。
    }
  })();
  res.status(204).end();
});

piRoute.post('/threads/:id/cancel', async (req, res) => {
  await assertThreadVisible(req.params.id!, req.user as AuthUser);
  cancelThread(req.params.id!);
  res.status(204).end();
});

piRoute.get('/models', async (_req, res) => {
  const cfg = await readLlmConfig();
  if (!cfg) { res.json([]); return; }
  // PiModelInfo 契约：非空字符串 provider + modelId
  res.json([{ provider: cfg.provider, modelId: cfg.model }]);
});

piRoute.get('/threads/:id/events', async (req, res) => {
  await assertThreadVisible(req.params.id!, req.user as AuthUser);
  const rid = (await db.select({ requirementId: aiThreads.requirementId }).from(aiThreads).where(eq(aiThreads.id, req.params.id!)).limit(1))[0]?.requirementId;
  if (!rid) { res.status(404).end(); return; }
  sseHeaders(res);
  try {
    const send = (e: unknown) => sseSend(res, e as unknown as Parameters<typeof sseSend>[1]);
    // subscribeThread 自带 snapshot（无活跃 session 时发合法空快照）
    const unsubThread = subscribeThread(req.params.id!, send, { includeSnapshot: true });
    // workspace 事件补上 react-pi 必需的 threadId + seq 信封（未知 type 也必须带全，否则客户端断流）
    let wsSeq = 0;
    const unsubWs = subscribeWorkspace(rid, (e) => {
      wsSeq += 1;
      send({ ...e, threadId: req.params.id!, seq: wsSeq });
    });
    req.on('close', () => { unsubThread(); unsubWs(); });
  } catch {
    res.end();
  }
});

// 501 stubs for endpoints the UI does not use
const notImplemented = (_req: Request, res: import('express').Response) => res.status(501).json({ error: 'not_implemented' });
piRoute.patch('/threads/:id', notImplemented);
piRoute.delete('/threads/:id', notImplemented);
piRoute.post('/threads/:id/model', notImplemented);
piRoute.post('/threads/:id/thinking', notImplemented);
piRoute.post('/host-ui', notImplemented);