/**
 * 探索式测试会话路由：章程驱动 → AI 在真实浏览器主动找茬 → findings（缺陷候选 + 证据截图）
 * → 人工确认/驳回 → 确认项可升格为用例草稿（未编译，走既有 AI 编译流）。
 *
 * 会话执行走 exec 队列（kind:'exploration'），与计划运行/单用例同一 chromium 并发闸门。
 * 取消用 DB 列 cancel_requested（跨副本天然正确），worker 每轮轮询一次。
 */
import { Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { explorationFindings, explorationSessions, groups } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { assertProjectVisible, assertVersionVisible, visibleProjectIds } from '../services/projectAccess.js';
import { handleLiveView, handleLiveReplay, handleLiveReplayMeta, replaySpeedOf } from '../execute/liveView.js';
import { getExecutionQueue, isExecutionQueueReady, EXEC_QUEUE_NAME } from '../scheduler/execQueue.js';
import { runExplorationSession, removeExplorationScreenshots } from '../execute/exploration.js';
import { trailToSteps, mergeExplorationTrails } from '../execute/explorationPrompt.js';
import { parsePaging } from '../lib/pagination.js';
import { createCaseWithSteps } from '../services/cases.service.js';
import { attachCreators } from '../lib/creator.js';
import { logger } from '../logger.js';
import { EXPLORATION_PERSONA_KEYS } from '@itest/shared';

export const explorationsRoute = Router();

const CreateBody = z.object({
  versionId: z.string().uuid(),
  /** 探索章程：给 AI 的自然语言目标与范围（10~4000 字）。 */
  charter: z.string().trim().min(10).max(4000),
  persona: z.enum(EXPLORATION_PERSONA_KEYS as [string, ...string[]]).default('qa'),
  title: z.string().trim().min(1).max(200).optional(),
  startUrl: z.string().trim().max(2000).optional(),
});

const ListQuery = z.object({
  versionId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
});

/** 会话可见性断言：经 session.projectId 判定，不存在与不可见统一 404。 */
async function loadSession(sessionId: string, user: { userId: string }) {
  const row = (await db.select().from(explorationSessions).where(eq(explorationSessions.id, sessionId)))[0];
  if (!row) throw new HttpError(404, 'not_found', 'exploration session not found');
  await assertProjectVisible(row.projectId, user as never);
  return row;
}

/**
 * 新建探索会话：落库 pending → 入队执行 → 立即返回（前端轮询详情页看实时画面与 findings）。
 * 入队三段式与 execute.ts 一致：redis 就绪入队；add 失败回落 inline；无 redis 直接 inline。
 * runner 内部对 pending→running 做原子认领，重复派发不会跑两遍。
 */
explorationsRoute.post('/', async (req, res) => {
  const body = CreateBody.parse(req.body);
  const { projectId } = await assertVersionVisible(body.versionId, req.user!);
  const title = body.title?.trim() || body.charter.slice(0, 80);
  const inserted = (await db
    .insert(explorationSessions)
    .values({
      projectId,
      versionId: body.versionId,
      title,
      charter: body.charter,
      persona: body.persona,
      startUrl: body.startUrl?.trim() || null,
      status: 'pending',
      createdByUserId: req.user!.userId,
    })
    .returning())[0]!;
  const sessionId = inserted.id;

  if (isExecutionQueueReady()) {
    try {
      await getExecutionQueue().add(EXEC_QUEUE_NAME, { kind: 'exploration', sessionId });
    } catch (e) {
      logger.warn({ err: e, sessionId }, 'exec queue add failed; running exploration inline');
      void runExplorationSession({ sessionId });
    }
  } else {
    void runExplorationSession({ sessionId });
  }

  res.status(201).json(inserted);
});

/** 列表：可按 versionId / projectId 过滤；两者都不给则返回当前用户可见项目的全部会话。 */
explorationsRoute.get('/', async (req, res) => {
  const q = ListQuery.parse(req.query);
  const { page, limit } = parsePaging(req.query);
  const filters: SQL[] = [];
  if (q.versionId) {
    // 带版本过滤也要过可见性：否则知道 versionId 就能列出他组织的会话
    const { projectId } = await assertVersionVisible(q.versionId, req.user!);
    filters.push(eq(explorationSessions.versionId, q.versionId));
    filters.push(eq(explorationSessions.projectId, projectId));
  } else if (q.projectId) {
    await assertProjectVisible(q.projectId, req.user!);
    filters.push(eq(explorationSessions.projectId, q.projectId));
  } else {
    const ids = await visibleProjectIds(req.user!);
    if (ids.length === 0) return res.json({ items: [], total: 0, page, limit });
    filters.push(inArray(explorationSessions.projectId, ids));
  }
  const where = filters.length > 1 ? and(...filters) : filters[0]!;

  const [items, totalRows] = await Promise.all([
    db
      .select()
      .from(explorationSessions)
      .where(where)
      .orderBy(desc(explorationSessions.createdAt))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ count: sql<number>`count(*)::int` }).from(explorationSessions).where(where),
  ]);
  res.json({ items: await attachCreators(items), total: totalRows[0]?.count ?? 0, page, limit });
});

/** 详情：会话 + findings（按 order 升序）+ 创建人 + 会话过程（每一步动作留痕）。 */
explorationsRoute.get('/:id', async (req, res) => {
  const session = await loadSession(req.params.id!, req.user!);
  const findings = await db
    .select()
    .from(explorationFindings)
    .where(eq(explorationFindings.sessionId, session.id))
    .orderBy(asc(explorationFindings.order));
  const [withCreator] = await attachCreators([session]);
  // 会话级留痕列是整场动作序列；老会话没有这列数据，回落合并各 finding 的片段。
  const steps = session.actionsTrail?.length ? session.actionsTrail : mergeExplorationTrails(findings);
  res.json({ ...withCreator, findings, steps });
});

/**
 * 取消会话：置 cancel_requested=true。幂等——终态会话再调也返回 ok（不再有 worker 轮询它）。
 * pending 期取消：runner 认领后立即走快速收尾路径，不开浏览器。
 */
explorationsRoute.post('/:id/cancel', async (req, res) => {
  const session = await loadSession(req.params.id!, req.user!);
  await db
    .update(explorationSessions)
    .set({ cancelRequested: true, updatedAt: new Date() })
    .where(eq(explorationSessions.id, session.id));
  res.json({ ok: true });
});

/**
 * 删除会话：findings 级联删；截图目录一并清理。
 * running/pending 会话默认禁删（执行器还在往里写截图与 findings）；
 * 但已请求取消（cancel_requested）的会话放行——执行器会在下一轮轮询时优雅收尾，
 * 其迟到写入由 FK/try-catch 兜住，而执行器进程已死（API 重启/崩溃）留下的孤儿会话
 * 永远等不到收尾，不放行就会卡在 running 态既不能删也不能看。
 */
explorationsRoute.delete('/:id', async (req, res) => {
  const session = await loadSession(req.params.id!, req.user!);
  const live = session.status === 'running' || session.status === 'pending';
  if (live && !session.cancelRequested) {
    throw new HttpError(409, 'exploration_running', 'exploration session is still running');
  }
  const deleted = await db
    .delete(explorationSessions)
    .where(eq(explorationSessions.id, session.id))
    .returning({ id: explorationSessions.id });
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'exploration session not found');
  await removeExplorationScreenshots(session.id);
  res.json({ ok: true });
});

/**
 * 实时画面（MJPEG）：runner 注册的 `exploration:<id>` 源，运行中才可连。
 *  ?replay=1 为本轮录制的回放；&speed=N 为回放倍速；?replay=meta 探测录制是否仍可回放。
 */
explorationsRoute.get('/:id/live', async (req, res) => {
  const session = await loadSession(req.params.id!, req.user!);
  if (req.query.replay === 'meta') return handleLiveReplayMeta(res, `exploration:${session.id}`);
  if (req.query.replay === '1') return handleLiveReplay(req, res, `exploration:${session.id}`, { speed: replaySpeedOf(req.query) });
  handleLiveView(req, res, `exploration:${session.id}`);
});

const ReviewBody = z.object({ decision: z.enum(['confirmed', 'dismissed']) });

const PromoteBody = z.object({
  groupId: z.string().uuid(),
  title: z.string().trim().min(1).max(200).optional(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
});

/** 取 finding 并校验其属于该会话（跨会话/不存在统一 404）。 */
async function loadFinding(sessionId: string, findingId: string) {
  const row = (await db.select().from(explorationFindings).where(eq(explorationFindings.id, findingId)))[0];
  if (!row || row.sessionId !== sessionId) throw new HttpError(404, 'not_found', 'finding not found');
  return row;
}

/**
 * 审阅 finding：确认（confirmed）或驳回（dismissed）。
 * 只认 pending——已审过的再审报 409，避免静默覆盖审阅结论。
 */
explorationsRoute.post('/:id/findings/:fid/review', async (req, res) => {
  const session = await loadSession(req.params.id!, req.user!);
  const body = ReviewBody.parse(req.body);
  const finding = await loadFinding(session.id, req.params.fid!);
  if (finding.status !== 'pending') {
    throw new HttpError(409, 'already_reviewed', 'finding is not pending');
  }
  const updated = (await db
    .update(explorationFindings)
    .set({ status: body.decision, reviewedBy: req.user!.userId, reviewedAt: new Date() })
    .where(eq(explorationFindings.id, finding.id))
    .returning())[0]!;
  res.json(updated);
});

/**
 * 复现步骤文本：优先模型给的 reproSteps（可能脑补）；空则用平台记录的动作留痕文本化兜底
 * （留痕是实际发生过的动作序列，是 ground truth）。
 */
function reproStepsOf(finding: { reproSteps: unknown; actionsTrail: unknown }): string[] {
  const repro = Array.isArray(finding.reproSteps) ? finding.reproSteps : [];
  const fromModel = repro
    .map((s) => {
      const action = (s as { action?: unknown } | null)?.action;
      return typeof action === 'string' ? action.trim() : '';
    })
    .filter(Boolean);
  if (fromModel.length > 0) return fromModel;
  const trail = Array.isArray(finding.actionsTrail) ? finding.actionsTrail : [];
  return trailToSteps(trail).map((s) => s.action);
}

/**
 * 确认后的 finding 升格为用例草稿：步骤来自复现步骤，compiled=null（未编译）——
 * 复用既有「compile-missing 阻塞 + UI AI 编译」流程，探索侧绝不编译。
 */
explorationsRoute.post('/:id/findings/:fid/promote', async (req, res) => {
  const session = await loadSession(req.params.id!, req.user!);
  const body = PromoteBody.parse(req.body);
  const finding = await loadFinding(session.id, req.params.fid!);
  if (finding.status === 'promoted') {
    throw new HttpError(409, 'already_promoted', 'finding already promoted');
  }
  if (finding.status !== 'confirmed') {
    throw new HttpError(409, 'not_confirmed', 'finding must be confirmed before promotion');
  }
  const groupRow = (await db.select({ projectId: groups.projectId }).from(groups).where(eq(groups.id, body.groupId)))[0];
  if (!groupRow) throw new HttpError(404, 'not_found', 'group not found');
  if (groupRow.projectId !== session.projectId) {
    throw new HttpError(400, 'group_project_mismatch', 'group does not belong to this project');
  }
  const steps = reproStepsOf(finding);
  if (steps.length === 0) {
    throw new HttpError(400, 'no_repro_steps', 'finding has no reproducible steps');
  }
  const created = await createCaseWithSteps({
    groupId: body.groupId,
    versionId: session.versionId,
    title: body.title?.trim() || finding.title,
    description: finding.description,
    priority: body.priority ?? finding.severity,
    steps: steps.map((instruction) => ({ instruction, compiled: null })),
  });
  await db
    .update(explorationFindings)
    .set({ status: 'promoted', promotedCaseId: created.id })
    .where(eq(explorationFindings.id, finding.id));
  res.status(201).json({ caseId: created.id, findingId: finding.id });
});
