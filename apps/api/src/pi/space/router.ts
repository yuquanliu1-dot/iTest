/**
 * 版本空间 AI 助手 HTTP+SSE 契约(react-pi 兼容子集),挂载于 /api/assistant。
 * 只服务 kind='version' 线程。
 * 事件通道与 session fanOut 同源(含 emitThreadEvent 的 confirm_request)。
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { and, desc, eq, sql } from 'drizzle-orm';
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
import { subscribeThreadMirror } from './threadBus.js';
import { generateSpaceSuggestionsOnce } from './suggestions.js';
import { stageRoute } from './stageRoute.js';
import { saveDocxUpload, MAX_DOCX_BYTES } from './threadAttachments.js';
import { feedbackRoute } from './feedbackRoute.js';
import { getArtifact, readArtifactFile, contentDispositionUtf8, listThreadArtifacts } from './artifacts.js';
import { requireManager } from '../../middleware/auth.js';
import { guidesRoute } from './guidesRoute.js';
import { mcpServersRoute } from './mcpServersRoute.js';
import { skillsRoute } from './skillsRoute.js';
import {
  cancelThread, clearThreadQueue, dropSpaceRecord, ensureSpaceRecord, sendSpaceUserMessage, snapshotOfThread, spaceRepoIssue, subscribeThread, threadStatusAsync,
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

/** react-pi 契约:POST/GET threads 必须返回完整 PiThreadSnapshot;兜底空快照刻意无 seq(requirement 级 /api/pi 兜底带 legacy seq:0,勿同步)。
 *  异步:snapshotOfThread 内部要等 seq 泵排空,保证水位 ≥ 内容(毒快照会让前端双气泡)。 */
async function threadSnapshotResponse(threadId: string): Promise<ThreadSnapshot> {
  const live = await snapshotOfThread(threadId);
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
  const snap: ThreadSnapshot & { lastError?: string } = await threadSnapshotResponse(threadId);
  const issue = spaceRepoIssue(threadId);
  if (issue) snap.lastError = `仓库暂不可用:${issue};对话可用,repo 类工具在修复仓库配置前会失败`;
  res.json(snap);
});

/** GET /threads 的行选取列(piThreadId 供 fs 探测)。 */
const threadListColumns = {
  id: aiThreads.id, title: aiThreads.title, createdAt: aiThreads.createdAt,
  updatedAt: aiThreads.updatedAt, piThreadId: aiThreads.piThreadId,
};
type ThreadListRow = {
  id: string; title: string | null; createdAt: Date | null; updatedAt: Date | null; piThreadId: string;
};

/** 「有会话」判据 = session 文件真实存在。不能用 piThreadId !== '':pi 在 persist=true 时
 *  立即分配 sessionFile 路径(仅落盘延迟),草稿线程也有非空 piThreadId,会把没发过消息的
 *  空会话全放进历史列表——正是本过滤原本要防的。 */
async function probeSessionFiles(rows: ThreadListRow[]): Promise<boolean[]> {
  return Promise.all(rows.map((r) =>
    fs.access(r.piThreadId)
      .then(() => true)
      .catch((e: NodeJS.ErrnoException) => {
        // ENOENT 是常态(线程还没落盘);其余(EACCES/EIO/卷挂死)是环境故障,别静默吞掉。
        if (e.code !== 'ENOENT') logger.warn({ err: e, sessionFile: r.piThreadId }, 'session file probe failed');
        return false;
      })));
}

/** 序列化线程行(react-pi 校验兼容:title null 必须缺键;时间出 ISO)。status 走 async 版:
 *  本地无 record 时探他副本运行锁,轮询落在他副本时运行中的线程不被误标 idle。 */
async function serializeThreadRows(rows: ThreadListRow[]) {
  return Promise.all(rows.map(async (row) => ({
    id: row.id,
    // react-pi 的 isThreadMetadata 用 isOptionalString 校验 title:null 会被拒 → 整个列表
    // load 抛 Invalid Pi HTTP response。DB 无题线程(title NULL,首条消息落题前的窗口)
    // 必须序列化出 undefined(JSON 里直接缺键)。
    title: row.title ?? undefined,
    status: (await threadStatusAsync(row.id)) ?? 'idle',
    createdAt: row.createdAt?.toISOString(),
    updatedAt: row.updatedAt?.toISOString(),
  })));
}

/** 列表查询的公共 where:草稿行(piThreadId='')过不了文件判据(fs.access('')必拒),
 *  下推进 SQL 让 LIMIT 窗口只留给可能有会话的线程,否则空行吃掉配额、挤掉够格的旧线程。 */
function threadListWhere(versionId: string) {
  return and(eq(aiThreads.kind, 'version'), eq(aiThreads.versionId, versionId), sql`${aiThreads.piThreadId} <> ''`);
}

spaceRoute.get('/threads', async (req, res) => {
  const raw = req.query.versionId;
  // react-pi 的 list 走 ?workspacePath=(官方作用域通道,值即 versionId);页面级旧调用走 ?versionId=。
  const rawWs = req.query.workspacePath;
  const versionId = (typeof raw === 'string' ? raw : '') || (typeof rawWs === 'string' ? rawWs : '');
  // 两个参都没有 → 空列表(不越权返回跨版本数据)。
  if (!versionId) { res.json([]); return; }
  await assertVersionVisible(versionId, req.user as AuthUser);

  // 带 ?limit= 走分页契约({threads, hasMore});不带保持旧契约(20 硬顶 + 裸数组),遗留消费方零感知。
  const limitRaw = Number(req.query.limit);
  if (!Number.isFinite(limitRaw) || limitRaw < 1) {
    const rows = (await db
      .select(threadListColumns)
      .from(aiThreads)
      .where(threadListWhere(versionId))
      // 排序锚点=创建时间:updatedAt 会被改名/新消息落题等 UPDATE 顶起,旧会话上浮错位;
      // id 决胜给出全序,同刻 tie 的展示顺序原本未定义,无行为差异。
      .orderBy(desc(aiThreads.createdAt), desc(aiThreads.id))
      .limit(20)) as ThreadListRow[];
    const exists = await probeSessionFiles(rows);
    res.json(await serializeThreadRows(rows.filter((_, i) => exists[i])));
    return;
  }

  const limit = Math.min(Math.floor(limitRaw), 200);
  // 文件存在性只能逐行探测、无法下推进 SQL,过滤后可能不足页 ⇒ keyset 循环取数:
  // 每轮按 (createdAt,id) 全序取一批原始行,凑满 limit 或原始行耗尽为止(20 轮封顶,
  // 防全库草稿行把探测拖成全表扫)。游标 = 上一批最后一行的线程 id;比较值(createdAt,id)
  // 经行值子查询让 DB 自己解析——timestamp 是微秒精度,经 ISO 字符串往返会毫秒截断,
  // 同毫秒 tie 行会被跳过;子查询无此损耗。游标行被删 → 子查询 NULL → 整页空,接受
  // (仅另一端恰好删掉游标行时发生)。createdAt 不可变 ⇒ 位置稳定,keyset 无漂移。
  // 每轮多取 1 行作存在性判据 ⇒ hasMore 是精确值而非乐观猜测。乐观语义有实际害处:
  // 客户端每次 reload 都新鲜拉第 1 页并回写 hasMore,乐观 true 会在「已滚到底 + 库已
  // 耗尽」时把哨兵复活,触发一次注定为空的翻页请求;精确 false 让哨兵保持熄灭。
  const kept: ThreadListRow[] = [];
  let cursorId: string | undefined =
    typeof req.query.cursor === 'string' && req.query.cursor !== '' ? req.query.cursor : undefined;
  let hasMore = false;
  for (let round = 0; round < 20; round++) {
    const want = limit - kept.length;
    const batch = (await db
      .select(threadListColumns)
      .from(aiThreads)
      .where(and(
        threadListWhere(versionId),
        cursorId
          ? sql`(${aiThreads.createdAt}, ${aiThreads.id}) < (SELECT ${aiThreads.createdAt}, ${aiThreads.id} FROM ${aiThreads} WHERE ${aiThreads.id} = ${cursorId})`
          : undefined,
      ))
      .orderBy(desc(aiThreads.createdAt), desc(aiThreads.id))
      .limit(want + 1)) as ThreadListRow[];
    hasMore = batch.length > want;
    const page = hasMore ? batch.slice(0, want) : batch;
    const exists = await probeSessionFiles(page);
    for (let i = 0; i < page.length; i++) if (exists[i]) kept.push(page[i]!);
    if (kept.length >= limit) break; // 只能 ==:page ≤ want ⇒ kept ≤ limit;此时 hasMore 必为 true
    if (!hasMore) break; // 原始行耗尽(本批不足 want+1)
    cursorId = page[page.length - 1]!.id; // 被截掉的第 want+1 行下轮经 keyset 自然重取
  }
  res.json({ threads: await serializeThreadRows(kept), hasMore });
});

spaceRoute.get('/threads/:id', async (req, res) => {
  // assertSpaceThreadVisible 已保证 kind='version' 且行存在(否则 404)
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  // 必须先 ensure(与下方 SSE 路由同款):snapshotOfThread 只读内存 records,发版重启后
  // 历史线程在内存里是冷的 → 直接返回空快照,前端点开历史会话一片空白,必须再点一次
  // (第二次 SSE 已把会话从 JSONL 重建好)。这里从磁盘重建会话(冷路径实测 ~20ms,
  // 远小于用户感知阈值)让首击即出历史;ensure 幂等单飞,热线程零成本。
  try { await ensureSpaceRecord(req.params.id!); } catch { /* 构建失败仍返回兜底快照,不 500 */ }
  res.json(await threadSnapshotResponse(req.params.id!));
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
 *  经 dropSpaceRecord 释放(dispose + 退订),落盘的 session 文件另删,SSE 订阅者随后收到断连。 */
spaceRoute.delete('/threads/:id', async (req, res) => {
  const threadId = req.params.id!;
  await assertSpaceThreadVisible(threadId, req.user as AuthUser);
  // 会话文件路径必须在事务前读出:事务删掉 aiThreads 行后无从恢复。
  const row = (await db.select({ piThreadId: aiThreads.piThreadId }).from(aiThreads).where(eq(aiThreads.id, threadId)).limit(1))[0];
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
  // 事务外删会话文件:删除失败不该让 DB 回滚成「线程还在但文件没了」;
  // 文件不存在(ENOENT)静默忽略,其余故障记 warn——否则孤儿文件不留任何痕迹。
  if (row?.piThreadId) await fs.unlink(row.piThreadId).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') logger.warn({ err: e, sessionFile: row.piThreadId }, 'session file delete failed; orphaned');
  });
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

/** 助手 docx 预上传：composer 选文件即传（草稿线程尚无 threadId → 作用域=版本）。
 *  raw octet-stream + X-Filename（全局 express.raw 已挂，与 /api/cases 附件同模式）。
 *  引用标签由前端 adapter 在 send() 拼进消息正文——本路由不碰任何消息文本。
 *  X-Filename 走 encodeURIComponent（中文文件名直塞 Headers 在部分浏览器抛 ByteString 错），
 *  服务端解码，失败保原值。 */
spaceRoute.post('/versions/:versionId/attachments', async (req, res) => {
  const versionId = req.params.versionId!;
  await assertVersionVisible(versionId, req.user as AuthUser);
  const buf = req.body as Buffer;
  if (!Buffer.isBuffer(buf)) throw new HttpError(400, 'bad_request', 'expected octet-stream body');
  if (buf.length === 0) throw new HttpError(400, 'bad_request', 'empty body');
  if (buf.length > MAX_DOCX_BYTES) throw new HttpError(413, 'too_large', 'docx exceeds 10MB');
  const rawName = req.header('x-filename') ?? 'document.docx';
  let name = rawName;
  try { name = decodeURIComponent(rawName); } catch { /* 非编码值保原样 */ }
  const { row, deduped } = await saveDocxUpload({
    versionId,
    name,
    buf,
    createdByUserId: (req.user as AuthUser).userId ?? null,
  });
  res.json({
    name: row.name,
    path: row.storagePath,
    chars: row.extractedChars,
    size: row.sizeBytes,
    sha256: row.sha256,
    deduped,
    extracted: row.extractedPath !== null,
  });
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
 *  转写取服务端 session.messages 全文;失败语义见 suggestions.ts(HttpError 透出/其余兜底 [])。
 *  跨副本:会话记录常驻运行副本,本地冷但 pi 会话文件在共享卷 → ensure 从 JSONL 重建转写,
 *  修掉「轮询落在他副本时固定 404」。piThreadId 为空的孤儿行没有可重建的会话,跳过 ensure
 *  (避免为从未有过会话的线程触发一次完整建会话的副作用),404 语义不变。 */
spaceRoute.post('/threads/:id/suggestions', async (req, res) => {
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  const row = (await db.select({ piThreadId: aiThreads.piThreadId }).from(aiThreads).where(eq(aiThreads.id, req.params.id!)).limit(1))[0];
  if (row?.piThreadId) {
    try { await ensureSpaceRecord(req.params.id!); } catch { /* 404/502 语义由 generate 兜底 */ }
  }
  res.json(await generateSpaceSuggestionsOnce(req.params.id!));
});

spaceRoute.post('/threads/:id/confirm', async (req, res) => {
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  const body = req.body as { confirmId?: string; approved?: boolean };
  if (!body.confirmId || typeof body.approved !== 'boolean') {
    throw new HttpError(400, 'bad_request', 'confirmId and approved are required');
  }
  // async:本地无挂起时走跨副本门(GETDEL 认领 + PUBLISH 答案回挂起副本),miss 仍 404。
  if (!(await resolveConfirmation(body.confirmId, body.approved))) {
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
  let unsubMirror: (() => void) | null = null;
  // 心跳:长任务(verify_case 单步 AI 相可静默 240s)期间保证字节流不中断,否则 nginx
  // proxy_read_timeout(300s)会在读侧静默时段掐掉连接,react-pi 永不重连 = 前端永久冻结。
  // 注释帧 `: ping` 被 EventSource 丢弃,只保活不产生事件。写失败/断连即清定时器收尾。
  const stopHeartbeat = startSseHeartbeat(res);
  const cleanup = (): void => {
    stopHeartbeat();
    unsub?.();
    unsubMirror?.();
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
    // 跨副本镜像:线程常驻他副本时事件经 Redis 透传进同一响应(origin 过滤本副本回环,
    // 避免本地已送达的事件被重复透传)。线程在本副本运行时本地 listeners 覆盖,镜像静默。
    unsubMirror = subscribeThreadMirror(req.params.id!, send);
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

/** 某线程的持久产物列表（skill 生成的文档等）。前端切换会话时拉取，把下载卡灌回界面——
 *  SSE artifact 事件只在运行态推送、且服务侧重放缓冲在进程内存里，刷新页面会丢下载卡。 */
spaceRoute.get('/threads/:id/artifacts', async (req, res) => {
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  const items = await listThreadArtifacts(req.params.id!);
  res.json(items);
});

/** AI 产出文件下载（artifact 事件携带的 token 换文件流）。
 *  鉴权 = 线程可见（与 SSE 同款）；过期/不存在 410；文件被清扫 404。
 *  Content-Type 按产物记录里的 mime 出——不能写死 application/zip，否则 docx/xlsx/png
 *  在浏览器里会被当成 zip 下载（扩展名对但类型错）。 */
spaceRoute.get('/threads/:id/artifacts/:token', async (req, res) => {
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  const a = await getArtifact(req.params.token!);
  if (!a) throw new HttpError(410, 'artifact_expired', '文件已过期或不存在');
  if (a.threadId !== req.params.id) throw new HttpError(410, 'artifact_expired', '文件已过期或不存在');
  let buf: Buffer;
  try {
    buf = await readArtifactFile(a);
  } catch {
    throw new HttpError(404, 'not_found', '文件已被清理');
  }
  res.setHeader('Content-Type', a.mime);
  res.setHeader('Content-Disposition', contentDispositionUtf8(a.name));
  res.send(buf);
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
