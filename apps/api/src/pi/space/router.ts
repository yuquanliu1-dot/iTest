/**
 * 版本空间 AI 助手 HTTP+SSE 契约(react-pi 兼容子集),挂载于 /api/assistant。
 * 只服务 kind='version' 线程。
 * 事件通道与 session fanOut 同源(含 emitThreadEvent 的 confirm_request)。
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  aiThreads, aiStageCases, aiStageCaseOps, aiStageScenarios, aiStageEnvironments, aiStagePlans, aiStageDatasets,
} from '../../db/schema.js';
import { logger } from '../../logger.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { assertVersionVisible } from '../../services/projectAccess.js';
import { sseHeaders, sseSend, startSseHeartbeat } from '../../sse/pi.js';
import { handleLiveView, handleLiveReplay, handleLiveReplayMeta, replaySpeedOf } from '../../execute/liveView.js';
import type { AuthUser } from '../../services/auth.service.js';
import { readLlmConfig } from '../modelBridge.js';
import { resolveConfirmation } from './confirm.js';
import { generateSpaceSuggestionsOnce } from './suggestions.js';
import { stageRoute } from './stageRoute.js';
import { feedbackRoute } from './feedbackRoute.js';
import { requireManager } from '../../middleware/auth.js';
import { guidesRoute } from './guidesRoute.js';
import { mcpServersRoute } from './mcpServersRoute.js';
import { skillsRoute } from './skillsRoute.js';
import {
  cancelThread, clearThreadQueue, dropSpaceRecord, ensureSpaceRecord, sendSpaceUserMessage, snapshotOfThread, spaceRepoIssue, subscribeThread, threadStatus,
} from './session.js';
import type { ThreadSnapshot, SpacePromptImage } from './session.js';

export const spaceRoute = Router();

/** threadId → versionId;仅接受 kind='version'(requirement 线程归 /api/pi 管,这里一律 404)。 */
export async function assertSpaceThreadVisible(threadId: string, user: AuthUser): Promise<string> {
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
  const body = req.body as { metadata?: { versionId?: string }; workspacePath?: string };
  // react-pi 的 initialize 发 {workspacePath}(Pi 官方作用域通道),页面级旧调用发
  // {metadata:{versionId}};两条都认,versionId ≡ workspacePath(UUID 串)。
  const versionId = body.metadata?.versionId ?? body.workspacePath;
  if (!versionId) throw new HttpError(400, 'bad_request', 'metadata.versionId required');
  await assertVersionVisible(versionId, req.user as AuthUser);
  // 每次调用新建一线程(一版本多线程)。初始化失败(LLM 未配置等)→ 删行并透出错误,
  // 前端引导设置页;repo 不可用不阻断(session 照常建,原因经 lastError 透出)。
  const threadId = randomUUID();
  await db.insert(aiThreads).values({ id: threadId, kind: 'version', versionId, piThreadId: '', createdByUserId: (req.user as AuthUser).userId });
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
  // react-pi 的 list 走 ?workspacePath=(官方作用域通道,值即 versionId);页面级旧调用走 ?versionId=。
  const rawWs = req.query.workspacePath;
  const versionId = (typeof raw === 'string' ? raw : '') || (typeof rawWs === 'string' ? rawWs : '');
  // 两个参都没有 → 空列表(不越权返回跨版本数据)。
  if (!versionId) { res.json([]); return; }
  await assertVersionVisible(versionId, req.user as AuthUser);
  const rows = await db
    .select({
      id: aiThreads.id, title: aiThreads.title, createdAt: aiThreads.createdAt,
      updatedAt: aiThreads.updatedAt, piThreadId: aiThreads.piThreadId,
    })
    .from(aiThreads)
    .where(and(eq(aiThreads.kind, 'version'), eq(aiThreads.versionId, versionId)))
    .orderBy(desc(aiThreads.updatedAt))
    .limit(20);
  // 「有会话」判据 = session 文件真实存在。不能用 piThreadId !== '':pi 在 persist=true 时
  // 立即分配 sessionFile 路径(仅落盘延迟),草稿线程也有非空 piThreadId,会把没发过消息的
  // 空会话全放进历史列表——正是本过滤原本要防的。
  const exists = await Promise.all(rows.map((r) => fs.access(r.piThreadId).then(() => true).catch(() => false)));
  const withRecords = rows.filter((_, i) => exists[i]);
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

/** react-pi rename 契约:PATCH {title} → 204。空/非字符串 400;trim 后入库。 */
spaceRoute.patch('/threads/:id', async (req, res) => {
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  const body = req.body as { title?: unknown };
  if (typeof body.title !== 'string') throw new HttpError(400, 'bad_request', 'title required');
  const title = body.title.trim().slice(0, 200);
  await db.update(aiThreads).set({ title, updatedAt: new Date() }).where(eq(aiThreads.id, req.params.id!));
  res.status(204).end();
});

/** react-pi delete 契约:DELETE → 204(已不存在也 204,客户端对 404 同样容忍)。
 *  同事务清六张 ai_stage_* 暂存行(按 threadId,无 FK 级联)与线程行;内存会话
 *  经 dropSpaceRecord 释放(dispose + 退订),SSE 订阅者随后收到断连。 */
spaceRoute.delete('/threads/:id', async (req, res) => {
  const threadId = req.params.id!;
  await assertSpaceThreadVisible(threadId, req.user as AuthUser);
  await db.transaction(async (tx) => {
    await tx.delete(aiStageCases).where(eq(aiStageCases.threadId, threadId));
    await tx.delete(aiStageCaseOps).where(eq(aiStageCaseOps.threadId, threadId));
    await tx.delete(aiStageScenarios).where(eq(aiStageScenarios.threadId, threadId));
    await tx.delete(aiStageEnvironments).where(eq(aiStageEnvironments.threadId, threadId));
    await tx.delete(aiStagePlans).where(eq(aiStagePlans.threadId, threadId));
    await tx.delete(aiStageDatasets).where(eq(aiStageDatasets.threadId, threadId));
    await tx.delete(aiThreads).where(eq(aiThreads.id, threadId));
  });
  dropSpaceRecord(threadId);
  res.status(204).end();
});

spaceRoute.post('/threads/:id/messages', async (req, res) => {
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  const body = req.body as { input?: { content?: string; streamingBehavior?: string; attachments?: unknown } };
  const content = body.input?.content ?? '';
  // react-pi 的 ThreadController 按运行态派生出 streamingBehavior 并随 input 发来
  // (ThreadController.js:265)。必须透传给 session,否则运行中发消息会被 Pi 拒收:
  // 无参 prompt 在 isStreaming 时抛「Agent is already processing」。只认两个枚举值,
  // 未知值按缺省处理,不把任意字符串透进 SDK。
  const streamingBehavior = body.input?.streamingBehavior === 'steer' || body.input?.streamingBehavior === 'followUp'
    ? body.input.streamingBehavior
    : undefined;
  // images: react-pi 把 composer 附件转成 pi 的 ImageContent（{type,mimeType,data 裸 base64}），
  // 原样透进 prompt.images。不做校验直接透,会把 raw body 里的任意结构送进 SDK,
  // 故只认三个字段齐全、mimeType 为 image/*、data 为纯 base64 的项。
  const images = parsePromptImages(body.input?.attachments);
  // 不阻塞响应:先回 204,后台 ensure + 派发(与 requirement 流一致;LLM 未配置时静默,前端经快照感知)
  void (async () => {
    try {
      await ensureSpaceRecord(req.params.id!);
      await sendSpaceUserMessage(req.params.id!, content, streamingBehavior, images);
    } catch (err) {
      // 不能静默:sendSpaceUserMessage 内部已推 assistant_error 事件,这里兜底错误日志
      // (ensure 失败/prompt 抛错统一归因)。无此行时用户消息入库但 AI 零响应,前端零反馈。
      logger.error({ threadId: req.params.id, err }, 'space message dispatch failed');
    }
  })();
  res.status(204).end();
});

/** 单张图片的字节上限。base64 编码膨胀约 4/3,单条消息最坏体积由这两个常量
 *  与 ASSISTANT_JSON_BODY_LIMIT 共同决定(见 index.ts 的挂载顺序说明)。 */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** 单条消息的图片张数上限:对齐 Pi 侧能吃下的量,再多只是徒增 token 与延迟。 */
const MAX_IMAGES = 4;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
/** base64 长度 → 原字节数的上界。取整除会漏掉恰好等于上限的合法图,故向上取整。 */
const maxBase64Length = (bytes: number): number => Math.ceil(bytes / 3) * 4;

/** 从 input.attachments 里挑出合法的图片项。非法项静默丢弃（不报错）——
 *  附件是增强项,一张坏图不该让整条消息发不出去。 */
function parsePromptImages(raw: unknown): SpacePromptImage[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: SpacePromptImage[] = [];
  for (const item of raw) {
    if (out.length >= MAX_IMAGES) break;
    if (!item || typeof item !== 'object') continue;
    const a = item as { mimeType?: unknown; data?: unknown };
    if (typeof a.mimeType !== 'string' || !a.mimeType.startsWith('image/')) continue;
    if (typeof a.data !== 'string' || a.data.length === 0) continue;
    if (a.data.length > maxBase64Length(MAX_IMAGE_BYTES)) continue;
    if (!BASE64_RE.test(a.data)) continue;
    out.push({ data: a.data, mimeType: a.mimeType });
  }
  return out.length > 0 ? out : undefined;
}

/** 供 index.ts 计算该路由的 json body 上限:最坏图片体积 + 余量。 */
export const ASSISTANT_JSON_BODY_LIMIT = `${Math.ceil(maxBase64Length(MAX_IMAGE_BYTES) * MAX_IMAGES / 1024 / 1024) + 4}mb`;

spaceRoute.post('/threads/:id/cancel', async (req, res) => {
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  cancelThread(req.params.id!);
  res.status(204).end();
});

/** react-pi 契约的清排队路由(见 httpClient 的 wire contract)。返回被清内容,
 *  前端可把文字还原回输入框——用户取消排队时不该丢字。 */
spaceRoute.post('/threads/:id/queue/clear', async (req, res) => {
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  res.json(clearThreadQueue(req.params.id!));
});

/** 推荐追问:AI 回答落定后由前端按需拉取(POST 而非 GET:触发了 LLM 调用,不该被缓存/预取)。
 *  转写取服务端 session.messages 全文;失败语义见 suggestions.ts(HttpError 透出/其余兜底 [])。 */
spaceRoute.post('/threads/:id/suggestions', async (req, res) => {
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  res.json(await generateSpaceSuggestionsOnce(req.params.id!));
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
  // 心跳:长任务(verify_case 单步 AI 相可静默 240s)期间保证字节流不中断,否则 nginx
  // proxy_read_timeout(300s)会在读侧静默时段掐掉连接,react-pi 永不重连 = 前端永久冻结。
  // 注释帧 `: ping` 被 EventSource 丢弃,只保活不产生事件。写失败/断连即清定时器收尾。
  const stopHeartbeat = startSseHeartbeat(res);
  const cleanup = (): void => {
    stopHeartbeat();
    unsub?.();
  };
  res.on('error', cleanup);
  req.on('close', () => { closed = true; cleanup(); });
  // 订阅前先确保 session 已构建:SSE 早于首条消息时若无 record,listener 会注册到
  // noop 上,后续 confirm_request/stage 全丢;ensure 幂等单飞,已有缓存直接返回。
  // 失败(LLM 未配置等)保留空快照语义,不中断连接。
  try { await ensureSpaceRecord(req.params.id!); } catch { /* 线程无法活跃,仍可接收快照 */ }
  if (closed) { cleanup(); return; }
  try {
    const send = (e: unknown) => sseSend(res, e as unknown as Parameters<typeof sseSend>[1]);
    // subscribeThread 自带 snapshot(无活跃 session 时发合法空快照),并在快照后按原序重放
    // 断线期间缓冲的会话内自定义事件(verify_progress/announce/stage/…)与仍挂起的确认卡,
    // 前端 store 按 seq 去重——重连不丢实时状态;confirm_request / 舞台事件经 emitThreadEvent
    // 走同一 listeners 通道。
    // subscribeThread 同步返回 unsub:自上方的 closed 检查到赋值之间无 await,无竞态窗口。
    unsub = subscribeThread(req.params.id!, send, { includeSnapshot: true });
  } catch {
    cleanup();
    if (res.writable && !res.writableEnded) res.end();
  }
});

/** 助手 playground 实时画面：verify_case / solidify_case 执行期间的 MJPEG 流。
 *  鉴权与 SSE 一致（线程可见性）；key 由工具运行时随机生成且随 start 事件下发。
 *  ?replay=1 为本轮工具执行的录制回放（执行结束 30min 内）；&speed=N 为回放倍速；
 *  ?replay=meta 探测录制是否仍可回放（前端据此决定是否显示「回放」按钮）。 */
spaceRoute.get('/threads/:id/live/:key', async (req, res) => {
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  if (req.query.replay === 'meta') return handleLiveReplayMeta(res, req.params.key!);
  if (req.query.replay === '1') return handleLiveReplay(req, res, req.params.key!, { speed: replaySpeedOf(req.query) });
  handleLiveView(req, res, req.params.key!);
});

spaceRoute.use(stageRoute);

// 用户反馈（只收集不消费）。与 stage 同档：不挂 requireManager——提交反馈是普通用户
// 行为，线程可见性由 feedbackRoute 内的 assertSpaceThreadVisible 兜底。
spaceRoute.use(feedbackRoute);

// 管理端 CRUD：requireManager 保护（member → 403）。挂在 /api/assistant 之下，
// 全局 requireAuth 由更外层 index.ts 统一承担（router.ts 自身不重复鉴权）。
spaceRoute.use('/guides', requireManager, guidesRoute);
spaceRoute.use('/mcp-servers', requireManager, mcpServersRoute);
spaceRoute.use('/skills', requireManager, skillsRoute);
