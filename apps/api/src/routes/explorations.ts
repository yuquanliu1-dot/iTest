/**
 * 探索式测试会话路由：章程驱动 → AI 在真实浏览器主动找茬 → findings（缺陷候选 + 证据截图）
 * → 人工确认/驳回 → 确认项可升格为用例草稿（平台留痕 best-effort 机械出 DSL，余下走既有 AI 编译流）。
 *
 * 会话执行走 exec 队列（kind:'exploration'），与计划运行/单用例同一 chromium 并发闸门。
 * 取消用 DB 列 cancel_requested（跨副本天然正确），worker 每轮轮询一次。
 */
import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { explorationFindings, explorationSessions, groups } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { assertProjectVisible, assertVersionVisible, visibleProjectIds } from '../services/projectAccess.js';
import { handleLiveView, handleLiveReplay, handleLiveReplayMeta, replaySpeedOf } from '../execute/liveView.js';
import { getExecutionQueue, isExecutionQueueReady, EXEC_QUEUE_NAME } from '../scheduler/execQueue.js';
import { runExplorationSession, removeExplorationScreenshots } from '../execute/exploration.js';
import { trailToCaseSteps, mergeExplorationTrails } from '../execute/explorationPrompt.js';
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
  /**
   * 破坏性操作授权（默认拒）：勾了才允许探索点击删除/支付/发送这类不可逆入口。
   * charter 说辞不算授权——机械闸只认这个显式开关（2026-11-10 prod 实录：章程要求核查
   * 删除是否真落库 → 模型点了删除 → 资产真被删）。
   */
  allowDestructive: z.boolean().default(false),
  /**
   * 浏览器视口宽高（两态：缺省=默认 1280×800；同给=自定义）。只给一个 → 400 window_required
   * （复用用例窗口校验的 i18n 文案）。
   */
  windowWidth: z.number().int().positive().optional(),
  windowHeight: z.number().int().positive().optional(),
  /** 轮次预算（默认 24，4~60）：软预算，超界优雅收尾，已发现的 findings 全保留。 */
  budgetTurns: z.number().int().min(4).max(60).optional(),
});

const ListQuery = z.object({
  versionId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
});

/**
 * 人格矩阵建组（C3）：同一章程起 N 个人格会话并行跑（同一 matrix_id 分组）。
 * 不新建表——分组键/展示名/角色三列挂在 exploration_sessions 上。
 * personas 去重后逐个建会话；每个会话 = 一次独立探索（各自章程分解、各自留痕）。
 */
const CreateMatrixBody = z.object({
  versionId: z.string().uuid(),
  charter: z.string().trim().min(10).max(4000),
  /** 人格列表（1~6 个，重复的自动去重）：每个 persona 一个会话。 */
  personas: z.array(z.enum(EXPLORATION_PERSONA_KEYS as [string, ...string[]])).min(1).max(6),
  /** 矩阵展示名（缺省按人格数生成）。 */
  label: z.string().trim().min(1).max(120).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  startUrl: z.string().trim().max(2000).optional(),
  allowDestructive: z.boolean().default(false),
  windowWidth: z.number().int().positive().optional(),
  windowHeight: z.number().int().positive().optional(),
  budgetTurns: z.number().int().min(4).max(60).optional(),
});

/** 会话可见性断言：经 session.projectId 判定，不存在与不可见统一 404。 */
async function loadSession(sessionId: string, user: { userId: string }) {
  const row = (await db.select().from(explorationSessions).where(eq(explorationSessions.id, sessionId)))[0];
  if (!row) throw new HttpError(404, 'not_found', 'exploration session not found');
  await assertProjectVisible(row.projectId, user as never);
  return row;
}

/**
 * 派发探索会话：redis 就绪入队；add 失败回落 inline；无 redis 直接 inline。
 * 单建与矩阵建组共用这一处——两条路径的派发语义必须一致（否则矩阵会话的排队/内联行为与单建不同）。
 */
async function dispatchExploration(sessionId: string): Promise<void> {
  if (isExecutionQueueReady()) {
    try {
      await getExecutionQueue().add(EXEC_QUEUE_NAME, { kind: 'exploration', sessionId });
      return;
    } catch (e) {
      logger.warn({ err: e, sessionId }, 'exec queue add failed; running exploration inline');
    }
  }
  void runExplorationSession({ sessionId });
}

/**
 * 新建探索会话：落库 pending → 入队执行 → 立即返回（前端轮询详情页看实时画面与 findings）。
 * 入队三段式与 execute.ts 一致：redis 就绪入队；add 失败回落 inline；无 redis 直接 inline。
 * runner 内部对 pending→running 做原子认领，重复派发不会跑两遍。
 */
explorationsRoute.post('/', async (req, res) => {
  const body = CreateBody.parse(req.body);
  // 两态校验：要么都不给（默认 1280×800），要么成对给（自定义）；只给一个 = 参数不完整。
  if ((body.windowWidth === undefined) !== (body.windowHeight === undefined)) {
    throw new HttpError(400, 'window_required', 'windowWidth and windowHeight must be provided together');
  }
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
      allowDestructive: body.allowDestructive,
      windowWidth: body.windowWidth ?? null,
      windowHeight: body.windowHeight ?? null,
      budgetTurns: body.budgetTurns ?? null,
      status: 'pending',
      // 范围解析在 runner 后台做（LLM+git 可能数十秒）——先落 pending，前端轮询详情页看结果。
      codeScopeStatus: 'pending',
      createdByUserId: req.user!.userId,
    })
    .returning())[0]!;
  const sessionId = inserted.id;

  await dispatchExploration(sessionId);

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

/**
 * 建人格矩阵（C3）：同一章程 + 多个 persona → 多个并行探索会话（同一 matrix_id）。
 * 一次性返回 matrixId 与全部会话（前端跳到矩阵视图看各会话进度）。
 * 路由必须注册在 `/:id/live` 之前——否则 `/matrix/:id` 会被 `/:id/live` 抢走。
 */
explorationsRoute.post('/matrix', async (req, res) => {
  const body = CreateMatrixBody.parse(req.body);
  if ((body.windowWidth === undefined) !== (body.windowHeight === undefined)) {
    throw new HttpError(400, 'window_required', 'windowWidth and windowHeight must be provided together');
  }
  const { projectId } = await assertVersionVisible(body.versionId, req.user!);
  const personas = [...new Set(body.personas)];
  const matrixId = randomUUID();
  const label = body.label?.trim() || `${personas.length} 人格矩阵`;
  const title = body.title?.trim() || body.charter.slice(0, 80);
  const inserted = await db
    .insert(explorationSessions)
    .values(
      personas.map((persona) => ({
        projectId,
        versionId: body.versionId,
        title,
        charter: body.charter,
        persona,
        startUrl: body.startUrl?.trim() || null,
        allowDestructive: body.allowDestructive,
        windowWidth: body.windowWidth ?? null,
        windowHeight: body.windowHeight ?? null,
        budgetTurns: body.budgetTurns ?? null,
        status: 'pending' as const,
        codeScopeStatus: 'pending' as const,
        matrixId,
        matrixLabel: label,
        matrixRole: persona,
        createdByUserId: req.user!.userId,
      })),
    )
    .returning();
  for (const row of inserted) await dispatchExploration(row.id);
  res.status(201).json({ matrixId, label, sessions: inserted });
});

/**
 * 矩阵视图：矩阵内全部会话 + 它们的 findings（finding 带 crossSessionCount —— ≥2 = 多视角共同发现）。
 * 交集数字由收尾时重算（S2），此处只读。
 */
explorationsRoute.get('/matrix/:matrixId', async (req, res) => {
  const matrixId = req.params.matrixId!;
  const sessions = await db
    .select()
    .from(explorationSessions)
    .where(eq(explorationSessions.matrixId, matrixId))
    .orderBy(asc(explorationSessions.createdAt));
  if (sessions.length === 0) throw new HttpError(404, 'not_found', 'matrix not found');
  await assertProjectVisible(sessions[0]!.projectId, req.user!);
  const findings = await db
    .select()
    .from(explorationFindings)
    .where(inArray(explorationFindings.sessionId, sessions.map((s) => s.id)))
    .orderBy(asc(explorationFindings.order));
  res.json({
    matrixId,
    label: sessions[0]!.matrixLabel,
    sessions: await attachCreators(sessions),
    findings,
  });
});

/**
 * 取消矩阵：给矩阵内**未终态**的会话置 cancel_requested（与单会话取消同款语义）。
 * 已终态的会话不再改（幂等：重复调用返回 ok）。
 */
explorationsRoute.post('/matrix/:matrixId/cancel', async (req, res) => {
  const matrixId = req.params.matrixId!;
  const sessions = await db
    .select({ id: explorationSessions.id, projectId: explorationSessions.projectId })
    .from(explorationSessions)
    .where(eq(explorationSessions.matrixId, matrixId));
  if (sessions.length === 0) throw new HttpError(404, 'not_found', 'matrix not found');
  await assertProjectVisible(sessions[0]!.projectId, req.user!);
  const cancelled = await db
    .update(explorationSessions)
    .set({ cancelRequested: true, updatedAt: new Date() })
    .where(
      and(
        eq(explorationSessions.matrixId, matrixId),
        inArray(explorationSessions.status, ['pending', 'running']),
      ),
    )
    .returning({ id: explorationSessions.id });
  res.json({ ok: true, cancelled: cancelled.length });
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
 * 升格步骤源（2026-11-11 口径）：优先平台留痕（ground truth，best-effort 机械 DSL——
 * click/fill/navigate 映射 compiled，映射不了的动作保持纯 NL），留痕不可用（老会话无
 * value/ms/key 字段、全部动作失败或取证类被滤）回落模型 reproSteps（纯 NL，待 AI 编译），
 * 双空返回 []（路由据此 400）。此前模型 reproSteps 优先——但它可能脑补，且与机械动作
 * 数量对不上，出不了 DSL。
 */
function promoteStepsOf(finding: { reproSteps: unknown; actionsTrail: unknown }): Array<{ instruction: string; compiled: unknown[] | null }> {
  const trail = Array.isArray(finding.actionsTrail) ? finding.actionsTrail : [];
  const fromTrail = trailToCaseSteps(trail);
  if (fromTrail.length > 0) return fromTrail;
  const repro = Array.isArray(finding.reproSteps) ? finding.reproSteps : [];
  const fromModel = repro
    .map((s) => {
      const action = (s as { action?: unknown } | null)?.action;
      return typeof action === 'string' ? action.trim() : '';
    })
    .filter(Boolean);
  return fromModel.map((instruction) => ({ instruction, compiled: null }));
}

/**
 * 确认后的 finding 升格为用例草稿：步骤优先取平台动作留痕做 best-effort 机械映射
 * （click/fill/navigate → compiled DSL，回放不走 AI）；映射不了的动作保持
 * instruction + compiled=null，复用既有「compile-missing 阻塞 + UI AI 编译」流程补齐。
 * 探索侧不做 AI 编译（不真跑不验收）——机械映射是零成本转换，不是编译。
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
  const steps = promoteStepsOf(finding);
  if (steps.length === 0) {
    throw new HttpError(400, 'no_repro_steps', 'finding has no reproducible steps');
  }
  const created = await createCaseWithSteps({
    groupId: body.groupId,
    versionId: session.versionId,
    title: body.title?.trim() || finding.title,
    description: finding.description,
    priority: body.priority ?? finding.severity,
    steps,
  });
  await db
    .update(explorationFindings)
    .set({ status: 'promoted', promotedCaseId: created.id })
    .where(eq(explorationFindings.id, finding.id));
  res.status(201).json({ caseId: created.id, findingId: finding.id });
});
