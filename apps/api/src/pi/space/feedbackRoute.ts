/**
 * 版本空间助手「用户反馈」HTTP 端点（Phase 1：只收集，不消费）：
 *   POST /assistant/feedback   提交一条反馈（👍/👎 + 可选文字）
 *   GET  /assistant/feedback?threadId=  列出当前用户在该线程下的反馈（前端标「已提交」）
 *
 * 为什么反馈要自带正文快照：消息全内存（SessionManager.inMemory），后端无法反查；
 * 且 pi 投影层的消息 id 只是位置索引（pi-msg:<index>），重启后无法复现。
 * 所以 excerpt 才是回溯的唯一可靠依据，anchor 仅作线索。
 *
 * 权限：提交反馈是普通用户行为，**刻意不挂 requireManager**（与 stageRoute 同档），
 * 线程可见性由 assertSpaceThreadVisible 兜底，跨组织统一 404 防存在性探测。
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { Router } from 'express';
import { db } from '../../db/client.js';
import { aiAssistantFeedback, projects, users } from '../../db/schema.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { requireManager } from '../../middleware/auth.js';
import { resolveVersionProjectId, visibleProjectIds } from '../../services/projectAccess.js';
import type { AuthUser } from '../../services/auth.service.js';
import { assertSpaceThreadVisible } from './router.js';

export const feedbackRoute = Router();

/** 正文快照上限：够看清语境，又不至于让反馈表膨胀成聊天记录。 */
const EXCERPT_LIMIT = 500;
const COMMENT_LIMIT = 2000;

interface CreateBody {
  threadId?: string;
  role?: string;
  messageAnchor?: string;
  messageIndex?: number;
  messageExcerpt?: string;
  messageAt?: string;
  sentiment?: string;
  comment?: string;
}

feedbackRoute.post('/feedback', async (req, res) => {
  const body = (req.body ?? {}) as CreateBody;
  const threadId = typeof body.threadId === 'string' ? body.threadId : '';
  if (!threadId) throw new HttpError(400, 'bad_request', 'threadId required');
  if (body.sentiment !== 'positive' && body.sentiment !== 'negative') {
    throw new HttpError(400, 'bad_request', 'sentiment must be positive or negative');
  }
  // 线程可见性（同时返回 versionId）；不可见/不存在统一 404。
  const versionId = await assertSpaceThreadVisible(threadId, req.user as AuthUser);
  const projectId = await resolveVersionProjectId(versionId);
  if (!projectId) throw new HttpError(500, 'invariant', 'version project missing');

  const userId = (req.user as { userId?: string } | undefined)?.userId ?? null;
  await db.insert(aiAssistantFeedback).values({
    threadId,
    versionId,
    projectId,
    userId,
    role: body.role === 'user' ? 'user' : 'assistant',
    messageAnchor: typeof body.messageAnchor === 'string' ? body.messageAnchor.slice(0, 64) : null,
    messageIndex: Number.isInteger(body.messageIndex) ? body.messageIndex! : null,
    messageExcerpt: typeof body.messageExcerpt === 'string' ? body.messageExcerpt.slice(0, EXCERPT_LIMIT) : null,
    messageAt: body.messageAt ? new Date(body.messageAt) : null,
    sentiment: body.sentiment,
    comment: typeof body.comment === 'string' ? body.comment.slice(0, COMMENT_LIMIT) : null,
  });
  res.status(204).end();
});

feedbackRoute.get('/feedback', async (req, res) => {
  const raw = req.query.threadId;
  const threadId = typeof raw === 'string' ? raw : '';
  if (!threadId) { res.json([]); return; }
  await assertSpaceThreadVisible(threadId, req.user as AuthUser);
  const userId = (req.user as { userId?: string } | undefined)?.userId ?? null;
  // 只返回当前用户自己提交的：气泡上的「已提交」标记是个人状态，不是协作状态。
  // userId 为空（理论上不该发生，全局 requireAuth 已保证）时返回空列表，
  // 而非把 userId IS NULL 当条件——那会把他人的匿名反馈算到自己头上。
  if (!userId) { res.json([]); return; }
  const rows = await db
    .select({
      id: aiAssistantFeedback.id,
      messageAnchor: aiAssistantFeedback.messageAnchor,
      messageIndex: aiAssistantFeedback.messageIndex,
      sentiment: aiAssistantFeedback.sentiment,
      createdAt: aiAssistantFeedback.createdAt,
    })
    .from(aiAssistantFeedback)
    .where(and(eq(aiAssistantFeedback.threadId, threadId), eq(aiAssistantFeedback.userId, userId)));
  res.json(rows.map((r) => ({
    id: r.id,
    messageAnchor: r.messageAnchor,
    messageIndex: r.messageIndex,
    sentiment: r.sentiment,
    createdAt: r.createdAt?.toISOString(),
  })));
});

/**
 * 管理端反馈列表（设置页用）。requireManager 挂在**单条路由**上而非整个 feedbackRoute ——
 * 上面 POST/GET 是普通用户行为，整个 router 挂 requireManager 会把提交反馈也挡在门外。
 *
 * 跨组织隔离：只返回调用者可见项目下的反馈（visibleProjectIds 子查询），与 guidesRoute 同策略。
 */
feedbackRoute.get('/feedback/all', requireManager, async (req, res) => {
  const sentiment = typeof req.query.sentiment === 'string' ? req.query.sentiment : '';
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  const conds = [inArray(aiAssistantFeedback.projectId, await visibleProjectIds(req.user as AuthUser))];
  if (sentiment === 'positive' || sentiment === 'negative') {
    conds.push(eq(aiAssistantFeedback.sentiment, sentiment));
  }
  if (projectId) conds.push(eq(aiAssistantFeedback.projectId, projectId));

  // limit 上限 200：收集期全量也不该让管理页一次吞下万行。
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const rows = await db
    .select({
      id: aiAssistantFeedback.id,
      threadId: aiAssistantFeedback.threadId,
      versionId: aiAssistantFeedback.versionId,
      projectId: aiAssistantFeedback.projectId,
      userId: aiAssistantFeedback.userId,
      sentiment: aiAssistantFeedback.sentiment,
      messageExcerpt: aiAssistantFeedback.messageExcerpt,
      comment: aiAssistantFeedback.comment,
      createdAt: aiAssistantFeedback.createdAt,
    })
    .from(aiAssistantFeedback)
    .where(and(...conds))
    .orderBy(desc(aiAssistantFeedback.createdAt))
    .limit(limit)
    .offset(offset);
  const countRows = await db
    .select({ count: sql<number>`count(*)` })
    .from(aiAssistantFeedback)
    .where(and(...conds));
  const total = Number(countRows[0]?.count ?? 0);

  // 用户名一并带出：管理页要看「谁提的」，省得前端再发一轮查用户的请求。
  const names = new Map<string, string>();
  const userIds = rows.map((r) => r.userId).filter((v): v is string => !!v);
  if (userIds.length) {
    for (const u of await db.select({ id: users.id, username: users.username, displayName: users.displayName })
      .from(users).where(inArray(users.id, userIds))) {
      names.set(u.id, u.displayName || u.username);
    }
  }
  res.json({
    total,
    rows: rows.map((r) => ({
      id: r.id,
      threadId: r.threadId,
      versionId: r.versionId,
      projectId: r.projectId,
      sentiment: r.sentiment,
      messageExcerpt: r.messageExcerpt,
      comment: r.comment,
      authorName: r.userId ? names.get(r.userId) ?? null : null,
      createdAt: r.createdAt?.toISOString(),
    })),
  });
});

/** 管理端筛选用的候选项目（与列表同可见性口径）。 */
feedbackRoute.get('/feedback/projects', requireManager, async (req, res) => {
  const ids = await visibleProjectIds(req.user as AuthUser);
  if (!ids.length) { res.json([]); return; }
  const rows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, ids));
  res.json(rows);
});
