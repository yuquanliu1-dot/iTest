/**
 * 版本空间 AI 助手线程 supervisor(pi/space)。
 * 绑定 versionId、一线程一 session、一版本可多线程。
 * 上下文摘要经 system prompt 注入(session 创建时)。
 */
import { and, eq } from 'drizzle-orm';
import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from '../../db/client.js';
import { aiThreads, projectVersions, users } from '../../db/schema.js';
import { aiLangFrom, type AiLang } from '../../agent/langDirective.js';
import { logger } from '../../logger.js';
import { isEffectiveManagerOf } from '../../services/auth.service.js';
import { buildSpaceTools } from './tools/index.js';
import { buildSkillsSectionContent } from './tools/readSkill.js';
import { buildSpaceSummary } from './summary.js';
import { type AssistantGuideRow, buildGuidesSection, loadActiveGuides } from './guides.js';
import { loadEnabledSkillDirs } from './skillsStore.js';
import { buildMcpExtensionFactory, getMcpServersForThread } from './mcp.js';
import { readLlmConfig, synthesizeModel, ENV_BY_PROVIDER } from '../modelBridge.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { defineTool, sessionEntryToContextMessages, type CompactionEntry, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { checkoutRepoForVersion, LockTimeoutError, RepoUnavailableError, DATA_DIR, REPOS_ROOT, WORKSPACES_ROOT } from '../repo.js';
import { emptyRepoState, type RepoState } from './tools/context.js';
import { pendingConfirmPayloads } from './confirm.js';
import { tryAcquireLock, type RedisLock } from '../../lib/redisLock.js';
import {
  allocateThreadSeq, currentThreadSeq, deleteThreadSeq,
  publishThreadCancel, publishThreadEvent, startThreadCommandWatch, threadRunRemote, THREAD_RUN_PREFIX,
} from './threadBus.js';

/** pi 会话 JSONL 落盘目录。落 .data 共享卷(prod228 三副本共享),不能走 pi 默认的
 *  ~/.pi/agent/sessions(容器内本地盘,跨副本看不见)。 */
export const SESSIONS_ROOT = path.join(DATA_DIR, 'pi-sessions');

/** 图片附件（pi-ai 的 ImageContent 形状）：base64 裸串，不带 data: 前缀。 */
export interface SpacePromptImage {
  data: string;
  mimeType: string;
}

export interface SpaceSessionLike {
  subscribe(fn: (e: unknown) => void): () => void;
  /** streamingBehavior 见 sendSpaceUserMessage:运行中不传会被 Pi 拒收。
   *  images 见 sendSpaceUserMessage:与 pi PromptOptions.images 同形。 */
  prompt(text: string, options?: { streamingBehavior?: 'steer' | 'followUp'; images?: SpacePromptImage[] }): Promise<void>;
  abort(): void;
  // pi v0.99.2 的 AgentSession.dispose 是同步 void（agent-session.d.ts:362）；不要 await。
  dispose(): void;
  /** 清空 Pi 服务端排队消息并返回被清内容（供 UI 还原到输入框）。 */
  clearQueue(): { steering: string[]; followUp: string[] };
  readonly isStreaming: boolean;
  // pi AgentSession 的公开 getter（agent-session.d.ts:421/757/387），快照用它带出压缩/重试
  // 活动标志。可选：测试桩不实现，真实 session 恒有。
  readonly isCompacting?: boolean;
  readonly isRetrying?: boolean;
  readonly retryAttempt?: number;
  messages: unknown[];
  /** 压缩摘要摘掉的历史前缀（branch 上 firstKeptEntryId 之前的 entries 转消息）。
   *  快照用它把全量历史按时间序拼进对话流——与活投影严格互补不交，整体替换语义下
   *  前端缓存不可能重复。测试桩可不实现（快照侧 ?? [] 兜底）。 */
  preCompactionMessages?(): unknown[];
}

export interface SpaceThreadContext {
  threadId: string;
  versionId: string;
  projectId: string;
  /** 仓库后台检出状态(session 建立时通常未就绪;检出完成/失败后字段就位)。 */
  repo: RepoState;
  /** 线程创建人：AI 代建对象(env/plan/...)以它为归属；历史线程为 null。 */
  createdByUserId: string | null;
  /** 线程创建人是否为有效管理员（管理类工具注册闸门）；历史线程为 false。 */
  manager: boolean;
  /** 线程创建人界面语言，历史线程缺省 zh-CN。 */
  lang?: AiLang;
  /** 已有会话的 JSONL 绝对路径(ai_threads.pi_thread_id)。为空串 → create 新建;
   *  有值 → 一律 open:文件在则恢复历史,文件缺失 pi 内部 newSession 并复用同一路径(不抛错)。 */
  piThreadId?: string;
  /** 线程用途：'rca' 根因分析线程（save_rca_result 注册闸门）；缺省 'chat'。 */
  purpose?: string;
}

export type SpaceSessionFactory = (ctx: SpaceThreadContext) => Promise<SpaceSessionLike>;

interface ThreadRecord {
  threadId: string;
  versionId: string;
  session: SpaceSessionLike;
  listeners: Set<(e: unknown) => void>;
  unsub: () => void;
  /** 已分配的最大事件 seq。 Redis 全局单调(itest:thread-seq:<id> INCR),冷构建时读当前
   *  高水位作基线;SSE 快照信封与 snapshotOf 都用它——前端靠它区分「旧事件」与「序列重置」。 */
  seq: number;
  /** 事件串行泵:fanOut/emitThreadEvent 只入队,泵任务依次 INCR 分配 seq → 发布镜像 →
   *  送达本地 listeners。链式 Promise 保证 FIFO;单条失败由 catch 兜住不拖垮后续。 */
  seqQueue: Promise<void>;
  turnIndex: number;
  /** 仓库后台检出状态(与工厂/工具共享同一可变引用)。 */
  repo: RepoState;
  /** 线程创建人界面语言(buildSpaceRecord 解析;推荐追问生成用它选提示词语言)。 */
  lang: AiLang;
  /** 断线重连重放缓冲:emitThreadEvent 追加的会话内自定义事件(条数有界 + TTL 双重上限)。 */
  customEvents: CustomEventRecord[];
  /** 跨副本运行闸门:runs>0 期间持有 itest:thread-run 锁并 5s 心跳续期(见 acquireRunSlot)。 */
  runs: number;
  runLock: RedisLock | null;
  runHeartbeat: NodeJS.Timeout | null;
}

/** 重放缓冲条目:事件体 + 发布时间。重放只补最近 CUSTOM_EVENT_REPLAY_TTL_MS 内的事件——
 *  隔夜/跨会话的陈旧进度卡(verify/announce)不会在重开线程或重进页面时复活。 */
interface CustomEventRecord {
  publishedAt: number;
  ev: Record<string, unknown>;
}

/** 缓冲条数上限:超限从最旧丢起(verify_case 20 步约 43 条事件,100 足够装下两轮)。 */
const MAX_CUSTOM_EVENT_BUFFER = 100;
/** 重放 TTL:只补 60min 内的事件(覆盖 verify_case 全局看门狗上限与 confirm 5min 挂起)。 */
const CUSTOM_EVENT_REPLAY_TTL_MS = 60 * 60_000;

const records = new Map<string, ThreadRecord>();
const inflight = new Map<string, Promise<ThreadRecord>>();

// 跨副本 cancel:他副本发来的命令 → 本地有 record 即 abort。threadBus 经此注入处理函数
// (避免模块环);无 Redis 时 startThreadCommandWatch 只注册不订阅。
startThreadCommandWatch((threadId) => {
  const rec = records.get(threadId);
  if (rec) rec.session.abort();
});

let factory: SpaceSessionFactory = createSpaceSessionFactory;

export function setSpaceSessionFactory(f: SpaceSessionFactory): void { factory = f; }

// ── 跨副本运行闸门(itest:thread-run 锁)───────────────────────────────────────
// nginx 轮询下用户与 rcaWorker 的 prompt 可能落在不同副本:同一线程两副本并发 prompt 会
// 交错写同一份 JSONL 转写。锁值=持有副本 ORIGIN_ID,TTL 300s + runs>0 期间 5s 心跳续期
// (TTL 取大:抖动时不会中途丢锁;副本死亡的锁至多 5min 自愈)。同副本并发(steer)按 runs
// 计数放行、复用同一把锁;他副本持有 → 抛错,由 sendSpaceUserMessage 的 catch 转 assistant_error。

const RUN_LOCK_TTL_MS = 300_000;
const RUN_HEARTBEAT_MS = 5_000;

async function acquireRunSlot(rec: ThreadRecord): Promise<void> {
  if (rec.runs > 0) {
    rec.runs += 1;
    return;
  }
  // 先同步占位再 await:并发首调在同帧内都会看到 runs=0,若先 await 后计数,
  // 两个快连发的 prompt 会各拿一次锁,输的那个被误判成「他副本持有」。
  rec.runs = 1;
  const lock = await tryAcquireLock(`${THREAD_RUN_PREFIX}${rec.threadId}`, RUN_LOCK_TTL_MS);
  if (!lock) {
    rec.runs = 0;
    throw new Error('该线程正在另一个实例上运行，请稍后再试');
  }
  rec.runLock = lock;
  rec.runHeartbeat = setInterval(() => { void rec.runLock?.refresh(); }, RUN_HEARTBEAT_MS);
}

function releaseRunSlot(rec: ThreadRecord): void {
  if (rec.runs === 0) return;
  rec.runs -= 1;
  if (rec.runs > 0) return;
  if (rec.runHeartbeat) { clearInterval(rec.runHeartbeat); rec.runHeartbeat = null; }
  void rec.runLock?.release();
  rec.runLock = null;
}

/** record 删除/进程内重置时兜底拆闸门:dispose 不保证 prompt promise 落定,不拆则心跳带着
 *  运行锁永久续期,线程在任何副本都无法再运行。 */
function teardownRunSlot(rec: ThreadRecord): void {
  if (rec.runHeartbeat) { clearInterval(rec.runHeartbeat); rec.runHeartbeat = null; }
  if (rec.runLock) { void rec.runLock.release(); rec.runLock = null; }
  rec.runs = 0;
}

export function resetSpaceSessions(): void {
  for (const r of records.values()) {
    teardownRunSlot(r);
    // dispose 是同步 void；会话内的 MCP 子进程/thread 生命周期随本进程，reset 不杀它们
    // （进程生命周期内线程常驻，teardown 支撑留给后续需求。见 mcp.ts child-leak deferral）。
    try { r.session.dispose(); } catch { /* ignore */ }
    try { r.unsub(); } catch { /* ignore */ }
  }
  records.clear();
  inflight.clear();
}

/** 线程被删除时释放其内存会话(dispose session + 退订 + 清 record)。无记录时静默。 */
export function dropSpaceRecord(threadId: string): void {
  const r = records.get(threadId);
  if (!r) return;
  deleteThreadSeq(threadId); // 卫生清理:不删也不影响正确性(线程 id 不复用)
  teardownRunSlot(r);
  try { r.session.dispose(); } catch { /* ignore */ }
  try { r.unsub(); } catch { /* ignore */ }
  records.delete(threadId);
  inflight.delete(threadId);
}

/** 幂等加载 version 级线程的 session(已缓存直接返回;并发首调共享同一构建;requirement 线程拒绝)。 */
export function ensureSpaceRecord(threadId: string): Promise<ThreadRecord> {
  const cached = records.get(threadId);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(threadId);
  if (pending) return pending;
  const p = buildSpaceRecord(threadId).finally(() => inflight.delete(threadId));
  inflight.set(threadId, p);
  return p;
}

async function buildSpaceRecord(threadId: string): Promise<ThreadRecord> {
  const row = (await db.select().from(aiThreads).where(and(eq(aiThreads.id, threadId), eq(aiThreads.kind, 'version'))).limit(1))[0];
  if (!row || !row.versionId) throw new Error('space thread not found');
  const v = (await db.select({ projectId: projectVersions.projectId }).from(projectVersions).where(eq(projectVersions.id, row.versionId)).limit(1))[0];
  if (!v) throw new Error('space thread version missing');

  // 线程创建人界面语言解析：session 的 AI 输出语言跟随创建人偏好；历史线程（创建人 null）缺省 zh-CN。
  let lang: AiLang = 'zh-CN';
  let manager = false;
  if (row.createdByUserId) {
    const u = (await db.select({ languagePreference: users.languagePreference }).from(users).where(eq(users.id, row.createdByUserId)).limit(1))[0];
    lang = aiLangFrom(u?.languagePreference ?? null);
    // 管理类工具（manage_skill / manage_mcp）只对「有效管理员」线程开放；历史线程（创建人 null）一律 false。
    manager = await isEffectiveManagerOf(row.createdByUserId);
  }

  // repo 后台异步检出:session 立即构建(新会话秒开,不等 git fetch 的网络往返),
  // repo 工具经共享 RepoState 每次调用动态解析 cwd;no_repo 静默(仅影响工具错误语态),
  // 其它失败记 repo.issue 供诊断,均不阻断会话。
  const repo = emptyRepoState();
  const session = await factory({ threadId, versionId: row.versionId, projectId: v.projectId, repo, createdByUserId: row.createdByUserId, lang, manager, piThreadId: row.piThreadId, purpose: row.purpose ?? 'chat' });
  // 冷构建基线:读 Redis 当前 seq 高水位作 rec.seq 起点。必须在 records.set(发布点)之前
  // 完成——订阅注册也在其后,任何 SSE 快照/GET 体都不会带出 0 基线,前端不会再把快照
  // 误判成「序列重置」而二次 append 镜像事件(用户消息双气泡的根因)。
  const seqBaseline = await currentThreadSeq(threadId);
  const rec: ThreadRecord = {
    threadId,
    versionId: row.versionId,
    session,
    listeners: new Set(),
    unsub: () => { /* assigned below */ },
    seq: seqBaseline,
    seqQueue: Promise.resolve(),
    turnIndex: -1,
    repo,
    lang,
    customEvents: [],
    runs: 0,
    runLock: null,
    runHeartbeat: null,
  };
  const unsub = session.subscribe((event) => fanOut(rec, event));
  rec.unsub = unsub;
  records.set(threadId, rec);
  // 后台检出：repo 目录位于版本工作空间的 repo/ 子目录。
  const workspaceDir = path.join(WORKSPACES_ROOT, `v-${row.versionId}`);
  const repoDir = path.join(workspaceDir, 'repo');
  void checkoutInBackground(row.versionId, repoDir, repo);
  return rec;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 后台检出:与 session 构建解耦;锁冲突(并发建线程共享同一次 fetch)等锁后重试,至多 3 次。 */
async function checkoutInBackground(versionId: string, repoDir: string, repo: RepoState): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      repo.cwd = await checkoutRepoForVersion(versionId, repoDir);
      return;
    } catch (e) {
      if (e instanceof LockTimeoutError) { await sleep(2_000); continue; }
      if (e instanceof RepoUnavailableError) {
        if (e.reason !== 'no_repo') {
          repo.issue = `${e.message}(${e.reason})`;
          logger.warn({ versionId, reason: e.reason, err: e.message }, 'space repo checkout failed');
        } else {
          repo.noRepo = true;
        }
        return;
      }
      // 非 RepoUnavailableError:通常是 spawn 二进制不存在(repo.ts:266 已翻译 git ENOENT)。
      // 显式匹配"git binary missing"以给出指向 api.Dockerfile 的可执行提示,其它错误照原样落 issue。
      logger.warn({ err: e, versionId }, 'space repo checkout failed');
      const errMsg = e instanceof Error ? e.message : String(e);
      repo.issue = /git binary missing|spawn git/.test(errMsg)
        ? 'git binary missing in container (rebuild api.Dockerfile)'
        : errMsg;
      return;
    }
  }
}

/** Pi AgentSession 事件 → react-pi body 的最小映射。 */
function mapSessionEvent(event: { type?: string } & Record<string, unknown>, ctx: { turnIndex: number }): Record<string, unknown> {
  switch (event.type) {
    case 'agent_start': return { type: 'agent_start' };
    case 'agent_settled': return { type: 'agent_settled' };
    case 'agent_end': return { type: 'agent_end', willRetry: event.willRetry };
    case 'turn_start': return { type: 'turn_start', turnIndex: ctx.turnIndex };
    case 'turn_end': return { type: 'turn_end', turnIndex: ctx.turnIndex };
    default: return event;
  }
}

/** 泵任务:全局 INCR 分配 seq → 发布跨副本镜像 → 送达本地 listeners。
 *  本地送达相对 pi 的同步发射异步化(多一次 Redis 往返,亚毫秒);换来的不变量是 seq
 *  全局单调,任何副本冷构建出的快照基线都不会再「重置」前端的旧事件门。 */
async function deliverThreadEvent(rec: ThreadRecord, body: Record<string, unknown>): Promise<void> {
  const seq = await allocateThreadSeq(rec.threadId);
  rec.seq = seq;
  const stamped = { ...body, threadId: rec.threadId, seq };
  publishThreadEvent(rec.threadId, stamped); // 跨副本镜像(fire-and-forget;SSE 侧按 origin 跳过回环)
  for (const fn of rec.listeners) {
    try { fn(stamped); } catch { /* listener errors do not break the supervisor */ }
  }
}

function fanOut(rec: ThreadRecord, event: unknown): void {
  const raw = event as { type?: string } & Record<string, unknown>;
  if (raw.type === 'turn_start') rec.turnIndex += 1;
  const body = mapSessionEvent(raw, { turnIndex: rec.turnIndex });
  rec.seqQueue = rec.seqQueue
    .then(() => deliverThreadEvent(rec, body))
    .catch((err) => logger.warn({ err, threadId: rec.threadId }, 'thread event delivery failed'));
}

/** 工具侧向线程 SSE 订阅者广播自定义事件(confirm_request 等);无活跃 session 时静默丢弃。 */
export function emitThreadEvent(threadId: string, e: Record<string, unknown>): void {
  const rec = records.get(threadId);
  if (!rec) return;
  rec.seqQueue = rec.seqQueue
    .then(() => deliverCustomEvent(rec, e))
    .catch((err) => logger.warn({ err, threadId }, 'thread custom event delivery failed'));
}

async function deliverCustomEvent(rec: ThreadRecord, e: Record<string, unknown>): Promise<void> {
  const seq = await allocateThreadSeq(rec.threadId);
  rec.seq = seq;
  const stamped = { ...e, threadId: rec.threadId, seq };
  // 缓冲自定义事件供断线重放。confirm_request 除外——确认卡的挂起协议在 confirm.ts,
  // 由 pending 表重放(只补仍挂起的卡,已处理/超时的不复活,见 subscribeThread)。
  if (e.type !== 'confirm_request') {
    rec.customEvents.push({ publishedAt: Date.now(), ev: stamped });
    if (rec.customEvents.length > MAX_CUSTOM_EVENT_BUFFER) rec.customEvents.shift();
  }
  publishThreadEvent(rec.threadId, stamped); // 跨副本镜像(fire-and-forget)
  for (const fn of rec.listeners) {
    try { fn(stamped); } catch { /* ignore */ }
  }
}

export interface ThreadSnapshot {
  metadata: {
    id: string;
    status: 'running' | 'idle';
    messageCount: number;
    /** 压缩/重试活动标志（react-pi 快照契约的可选字段）。缺失时前端在线程仍 running 期间
     *  会保留旧值（applySnapshot 的兼容回落）——compaction_end/auto_retry_end 事件一旦在
     *  断连窗口丢失，「正在压缩上下文」就永久卡住，下次重连快照也无法自愈。 */
    compactionActive?: boolean;
    retryActive?: boolean;
    retryAttempt?: number;
  };
  /** 快照对应的事件 seq 高水位:react-pi 用它做「快照比已见事件旧?」的序列重置检测。
   *  有 record 时必须带真实值——带 0 会被冷副本误判成重置 → 后续镜像事件二次 append
   *  (用户消息双气泡根因)。缺省(无 record 的兜底响应)客户端当 0,契约允许(可选字段)。 */
  seq?: number;
  messages: unknown[];
}

/**
 * 计算被压缩摘要「摘掉」的历史前缀：branch 路径上 [0, firstKeptEntryId) 的 entries
 * 转回消息（firstKept 不在路径上/为 null 时 = [0, compactionIdx)，对齐 buildContextEntries
 * 的保留语义——pi session-manager.js:201）。与活投影严格互补不交：prefix ∪ 活投影 = 全量
 * branch，故快照整体替换语义下前端缓存不可能重复。路径上的旧 compaction entry 转成
 * compactionSummary 消息（前端渲染为中途压缩标记行）。任何异常吞掉返回 []——快照
 * 不能因前缀计算失败而 500。
 */
export function preCompactionMessagesOf(sessionManager: { getBranch(): SessionEntry[] }): unknown[] {
  try {
    const path = sessionManager.getBranch();
    // 路径上最后一个 compaction 为准（buildContextEntries 同款遍历语义，分支回退时文件序最新≠路径上最新）
    let compactionIdx = -1;
    for (const [i, entry] of path.entries()) {
      if (entry.type === 'compaction') compactionIdx = i;
    }
    if (compactionIdx < 0) return [];
    const compaction = path[compactionIdx] as CompactionEntry;
    let boundary = compactionIdx;
    if (compaction.firstKeptEntryId) {
      const keptIdx = path.findIndex((e) => e.id === compaction.firstKeptEntryId);
      if (keptIdx >= 0 && keptIdx < compactionIdx) boundary = keptIdx;
    }
    return path
      .slice(0, boundary)
      .flatMap((e) => sessionEntryToContextMessages(e))
      .filter((m) => (m as { role?: string }).role !== 'system');
  } catch (e) {
    logger.warn({ err: e }, 'pre-compaction messages build failed; snapshot without prefix');
    return [];
  }
}

export function snapshotOf(rec: ThreadRecord): ThreadSnapshot {
  // 压缩/重试发生在 run 间隙（pi 的 isStreaming 此刻为 false），status 必须把它们算作
  // running——否则压缩进行中的合法快照被判 settled，前端压缩提示被误清。
  // 标志位对齐 react-pi 参考实现 ThreadSupervisor.metadataOf（client 侧校验接受这三个可选字段）。
  const compacting = rec.session.isCompacting ?? false;
  const retrying = rec.session.isRetrying ?? false;
  const pre = rec.session.preCompactionMessages?.() ?? [];
  return {
    seq: rec.seq,
    metadata: {
      id: rec.threadId,
      status: rec.session.isStreaming || compacting || retrying ? 'running' : 'idle',
      messageCount: pre.length + rec.session.messages.length,
      compactionActive: compacting,
      retryActive: retrying,
      retryAttempt: rec.session.retryAttempt ?? 0,
    },
    // 压缩前历史前缀拼在头部:对话流按时间序直接可见全量历史(前端 applySnapshot
    // 整体替换,拼接只在服务端这一处发生,持久化与缓存天然一致)。
    messages: [...pre, ...rec.session.messages],
  };
}

function snapshotEventOf(threadId: string, seq: number, snapshot: ThreadSnapshot): Record<string, unknown> {
  return { type: 'snapshot', snapshot, threadId, seq };
}

export function subscribeThread(
  threadId: string,
  fn: (e: unknown) => void,
  opts: { includeSnapshot?: boolean } = {},
): () => void {
  const rec = records.get(threadId);
  if (!rec) {
    if (opts.includeSnapshot === true) {
      fn(snapshotEventOf(threadId, 0, { metadata: { id: threadId, status: 'idle', messageCount: 0 }, messages: [] }));
    }
    return () => {};
  }
  if (opts.includeSnapshot === true) {
    // 快照携带当前 seq 先把会话基线定住,随后在同一同步帧内按发布时间重放缓冲事件
    // (verify_progress/announce/stage/solidify_progress)与仍挂起的确认卡,再注册监听器——
    // 重放先于任何后续实时事件,seq 单调不逆。前端 store 按 seq 去重:已处理过的实时
    // 事件不因重放二次生效,断线期间漏掉的事件自然补上(状态重建)。
    fn(snapshotEventOf(rec.threadId, rec.seq, snapshotOf(rec)));
    const now = Date.now();
    for (const r of rec.customEvents) {
      if (now - r.publishedAt > CUSTOM_EVENT_REPLAY_TTL_MS) continue;
      fn(r.ev);
    }
    for (const p of pendingConfirmPayloads()) {
      if (p.threadId === threadId) fn(p);
    }
  }
  rec.listeners.add(fn);
  return () => { rec.listeners.delete(fn); };
}

export function snapshotOfThread(threadId: string): ThreadSnapshot | null {
  const rec = records.get(threadId);
  return rec ? snapshotOf(rec) : null;
}

export function threadStatus(threadId: string): 'running' | 'idle' | undefined {
  const rec = records.get(threadId);
  if (!rec) return undefined;
  return rec.session.isStreaming ? 'running' : 'idle';
}

/** 跨副本版 threadStatus:本地 record 优先;冷 record 时探他副本的运行锁。线程列表序列化用
 *  (sync 版只看本副本,nginx 轮询下他副本运行中的线程会被误标 idle)。 */
export async function threadStatusAsync(threadId: string): Promise<'running' | 'idle' | undefined> {
  const local = threadStatus(threadId);
  if (local) return local;
  return (await threadRunRemote(threadId)) ? 'running' : undefined;
}

/** 线程构建后记录的仓库检出问题(非 no_repo);无 record 或检出未失败返回 null。 */
export function spaceRepoIssue(threadId: string): string | null {
  return records.get(threadId)?.repo.issue ?? null;
}

/** 旁路只读视图(推荐追问等非 session 生命周期消费者用):会话消息全文 + 创建人语言。
 *  不暴露 ThreadRecord 本体——listeners/seq/customEvents 属订阅机制,外部改动会破坏 SSE 契约。 */
export function getSpaceThreadView(threadId: string): { session: SpaceSessionLike; lang: AiLang } | null {
  const rec = records.get(threadId);
  return rec ? { session: rec.session, lang: rec.lang } : null;
}

export async function sendSpaceUserMessage(
  threadId: string,
  content: string,
  streamingBehavior?: 'steer' | 'followUp',
  images?: SpacePromptImage[],
): Promise<void> {
  const rec = records.get(threadId);
  if (!rec) throw new Error('thread not found');
  // 首条消息落线程标题(取用户原文截断)
  const row = (await db.select({ title: aiThreads.title }).from(aiThreads).where(eq(aiThreads.id, threadId)).limit(1))[0];
  if (row && !row.title) {
    await db.update(aiThreads).set({ title: Array.from(content.trim()).slice(0, 40).join(''), updatedAt: new Date() }).where(eq(aiThreads.id, threadId));
  }
  let slot = false;
  try {
    // 跨副本运行闸门:他副本持有锁 → 抛错,经下方 catch 转 assistant_error(用户面;messages
    // 路由 204 先行,HTTP 错误码冒泡不到前端)。同副本 steer 并发在 acquireRunSlot 内放行。
    await acquireRunSlot(rec);
    slot = true;
    // streamingBehavior 必须透传:Pi 在 isStreaming 时对无参 prompt 直接抛
    // 「Agent is already processing」(agent-session.js:1490)。前端 react-pi 的
    // ThreadController 已按运行态派生出 steer/followUp 并随 input 发来,这里只做转发。
    // images 同理:Pi 会逐张做 processImage(解码失败只降级为提示文本,不丢整条消息)。
    await rec.session.prompt(content, {
      ...(streamingBehavior ? { streamingBehavior } : {}),
      ...(images && images.length > 0 ? { images } : {}),
    });
  } catch (err) {
    // prompt 失败不能静默:用户消息已入库渲染,若无 AI 气泡也无错误提示就是"零反馈"假死。
    // 经 emitThreadEvent 推一条 assistant_error,SSE 订阅者(含 devtools/未来 UI 钩子)可见;
    // 然后 rethrow 让 router 层兜底日志,双层归因。
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ threadId, err }, 'space prompt failed');
    try {
      emitThreadEvent(threadId, { type: 'assistant_error', message });
    } catch { /* emit 失败不再遮蔽原始错误 */ }
    throw err;
  } finally {
    if (slot) releaseRunSlot(rec);
  }
  // 刷最后活跃时间:列表按 updatedAt 分桶(今天/昨天/7天内/…),不刷则分桶落到建会话那天,
  // 刚聊过的会话会留在旧桶里。放在 prompt 的 try 之外:prompt 失败已由 catch rethrow 返回,
  // 不会走到这里(失败的回合不刷时间);而这里是成功之后才执行的收尾,一次 UPDATE 失败
  // (长回合后连接池已排空是最常见诱因)只影响列表分桶,不该把成功的对话标成 assistant_error——
  // 那个事件会进 customEvents 并在重连时重放,等于给已成功的回合留一个持久化错误气泡。
  await db.update(aiThreads).set({ updatedAt: new Date() }).where(eq(aiThreads.id, threadId))
    .catch((e) => logger.warn({ threadId, err: e }, 'refresh ai_threads.updatedAt failed'));
}

export function cancelThread(threadId: string): void {
  const rec = records.get(threadId);
  // 本地快路径:record 在本副本直接 abort。命令仍广播(值=发起副本 ORIGIN_ID,各副本过滤
  // 自己的回环),线程常驻他副本时(rcaWorker 超时收尾/用户点停)由他副本的 watch 执行。
  if (rec) rec.session.abort();
  publishThreadCancel(threadId);
}

/** 清空 Pi 服务端排队消息,返回被清内容供前端还原到输入框。无会话/线程时返空。 */
export function clearThreadQueue(threadId: string): { steering: string[]; followUp: string[] } {
  const rec = records.get(threadId);
  if (!rec) return { steering: [], followUp: [] };
  return rec.session.clearQueue();
}

// ─────────────────────────────────────────────────────────────────────────────
// Real factory:注入空间工具(Plan 1 = repo 沙箱)并建 AgentSession
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 空间助手 preamble：替换 pi 默认的 "expert coding assistant operating inside pi"
 * （pi-coding-agent dist/core/system-prompt.js:81）。该段是模型唯一认定的身份来源，
 * appendSystemPrompt 落在 <addendum> 段，压不住默认 preamble 的自我认知——不改这里的话
 * 用户问「你是谁」会得到「我是 pi 里的编码助手」。
 *
 * **不要用 loader.systemPrompt 或直接改 systemPromptOptions.customPrompt**：两者都会让
 * system-prompt.js:76 的 `if (customPrompt)` 命中而整个跳过 else，连带丢掉 tools / rules /
 * docs 三段——rules 段承载 13 个空间工具的 promptGuidelines（STAGE_PROMPT_GUIDELINES 等），
 * 丢了等于静默废掉工具使用规范。buildRules 未导出，事后补不回来。
 *
 * 做法：before_agent_start 里拿到 pi 已渲染好的完整 system prompt，只把 preamble 那句
 * 默认文案替换掉，其余原样返回为 forceSystemPrompt。forceSystemPrompt 不进 transcript
 * （agent-session.js:1305 的 projection 只在请求头部投影），会话记录里的 sections 保持
 * 完整，diffSystemPromptSections 的前后对比也不会被这段改写污染。
 */
const PI_DEFAULT_PREAMBLE =
  'You are an expert coding assistant operating inside pi, a coding agent harness. '
  + 'You help users by reading files, executing commands, editing code, and writing new files.';

export function buildSpacePreamble(lang?: AiLang): string {
  const zh = 'zh-CN' === aiLangFrom(lang ?? null);
  return zh
    ? [
        '你是 iTest 平台的测试助手。你的职责是帮助用户设计和管理测试用例、编排执行计划、验证被测系统。',
        '不要把自己描述为编码助手、AI 编程助手或任何具体的底层框架；用户问「你是谁」时，用上面的定位回答。',
      ].join('\n')
    : [
        'You are the test assistant on the iTest platform. Your role is to help users design and manage test cases, orchestrate execution plans, and verify systems under test.',
        'Do not describe yourself as a coding assistant, an AI programming assistant, or any specific underlying framework; when asked "who are you", answer with the positioning above.',
      ].join('\n');
}

/**
 * 把 pi 默认 preamble 换成产品身份；渲染结果不含默认文案时（如上游已改）返回 undefined，
 * 让 pi 走原有逻辑而非用一份可能过期的全文覆盖。
 */
export function rewriteSpacePreamble(rendered: string, lang?: AiLang): string | undefined {
  if (!rendered.includes(PI_DEFAULT_PREAMBLE)) return undefined;
  return rendered.replace(PI_DEFAULT_PREAMBLE, buildSpacePreamble(lang));
}

/** 空间助手 system prompt：风格约束 + guides(需求设计方法/流程指令/知识参考) + 工作空间 + 版本上下文摘要。
 *  guides 由 loadActiveGuides 在工厂按 (lang, projectId, versionId) 查得；无摘要时省略上下文段。
 *  内容顺序与原硬编码一致（风格 → 需求设计/流程 → 工作空间 → 版本上下文），seed 后行为零变化。 */
export function buildSpaceSystemPrompt(
  summaryText: string | null,
  lang?: AiLang,
  guides: Array<Pick<AssistantGuideRow, 'kind' | 'body'>> = [],
): string {
  const isEn = aiLangFrom(lang ?? null) === 'en-US';
  const style = isEn
    ? '## Output style\n- The user writes in English. All replies MUST be in English (code, commands, and English terms may stay). This constraint covers every piece of user-visible text, including final replies, process explanations before tool calls, and reasoning monologues — do not write Chinese sentences like 「让我检查一下」, if you need to check something just call a tool.\n- Do not use emoji; emphasize with markdown bold, and enumerate with lists/tables.'
    : '## 输出风格\n- 用户使用简体中文提问,全部回复一律用简体中文(代码、命令、英文术语可保留原文)。这条约束覆盖**每一条**用户可见文本,包括最终答复、调用工具前的过程说明、以及思考/推理独白——不要出现「Let me check」「I found that」「I should」这类英文句子,想查什么直接调工具即可。\n- 不要使用 emoji;强调用 markdown 加粗,列举用列表/表格。';
  const workspace = '## 工作空间\n- 当前目录是版本专属工作空间，项目仓库已检出到 ./repo 子目录。\n- repo_ls / repo_read / repo_grep 仅在用户明确要求看代码或分析仓库时使用；用例创建与实测过程不要用它们做侦察——元素与页面问题以 verify_case 实测反馈为证据。';
  const guidesSection = buildGuidesSection(guides);
  const body = [style, guidesSection, workspace].filter(Boolean).join('\n\n');
  if (!summaryText) return body;
  return `${body}\n\n## 版本空间上下文\n${summaryText}`;
}

export async function createSpaceSessionFactory(ctx: SpaceThreadContext): Promise<SpaceSessionLike> {
  const cfg = await readLlmConfig();
  if (!cfg) {
    throw new HttpError(502, 'llm_not_configured', 'LLM 未配置:请先到设置页配置模型');
  }
  const { createAgentSession, SessionManager, DefaultResourceLoader, getAgentDir, loadSkills } = await import('@earendil-works/pi-coding-agent');
  const { getBuiltinModel } = await import('@earendil-works/pi-ai/providers/all');
  // 每个版本会话拥有独立工作空间：.data/workspaces/v-<versionId>，项目仓库检出在该空间下的 repo/ 子目录。
  // Agent 的 cwd 指向工作空间（避免写入污染仓库），repo 工具仍操作 repo/ 子目录。
  const workspaceDir = path.join(WORKSPACES_ROOT, `v-${ctx.versionId}`);
  const repoDir = path.join(workspaceDir, 'repo');
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(repoDir, { recursive: true });
  // Skills 物化为全局共享目录（.data/skills），由系统设置页管理；会话建立时物化 DB 快照。
  // 不再维护逐版本 .pi/skills 挂载目录——loadSkills/read_skill 全部改走 SKILLS_ROOT。
  // 物化失败不能拖垮会话工厂（无 skills 段，会话照常可用）。
  // 兼容旧目录布局：若旧 .data/repos/v-<versionId> 存在而新 repo/ 尚未初始化，直接迁移避免重复克隆。
  const legacyRepoDir = path.join(REPOS_ROOT, `v-${ctx.versionId}`);
  const gitDir = path.join(repoDir, '.git');
  const dirExists = async (p: string) => fs.stat(p).then((s) => s.isDirectory()).catch(() => false);
  if ((await dirExists(legacyRepoDir)) && !(await dirExists(gitDir))) {
    await fs.rm(repoDir, { recursive: true, force: true }).catch(() => {});
    await fs.rename(legacyRepoDir, repoDir).catch(() => {});
  }

  type ToolRaw = {
    name: string; description: string; parameters: ReturnType<typeof Type.Object>;
    execute: (input: unknown) => Promise<{ ok: true; data?: string } | { ok: false; error: string }>;
    promptGuidelines?: string[];
  };
  const rawTools: ToolRaw[] = buildSpaceTools({ ...ctx, workspaceDir, emit: (e) => emitThreadEvent(ctx.threadId, e) }) as ToolRaw[];
  const tools = rawTools.map((t) =>
    defineTool({
      name: t.name,
      label: t.name,
      description: t.description,
      parameters: t.parameters,
      ...(t.promptGuidelines ? { promptGuidelines: t.promptGuidelines } : {}),
      execute: async (_callId, params, _signal, _onUpdate, _ctx) => {
        const r = await t.execute(params);
        return r.ok
          ? { content: [{ type: 'text', text: r.data ?? 'ok' }], details: undefined }
          : { content: [{ type: 'text', text: r.error }], details: undefined, isError: true };
      },
    }),
  );

  // MCP servers：会话创建时读取（DB 驱动/测试桩）。无 server 时 register 为 no-op、connect 挂空配置。
  const mcpServers = await getMcpServersForThread({ threadId: ctx.threadId, projectId: ctx.projectId, versionId: ctx.versionId });
  const mcpExtensions = buildMcpExtensionFactory(mcpServers);

  const base = (getBuiltinModel as unknown as (p: string, m: string) => Record<string, unknown> | undefined)(cfg.provider, cfg.model)
    ?? synthesizeModel(cfg.provider, cfg.model, cfg.baseUrl);
  const envKey = ENV_BY_PROVIDER[cfg.provider];
  if (envKey && !process.env[envKey]) process.env[envKey] = cfg.apiKey;
  const model = { ...base, ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}) } as never;

  // 上下文摘要注入 system prompt(而非包装首条用户消息):包装会让服务端回显与
  // 前端乐观气泡文本不一致,react-pi 的 reconcile 无法去重 → 气泡重复且内部上下文泄漏到聊天区。
  let summaryText: string | null = null;
  try {
    summaryText = (await buildSpaceSummary(ctx.versionId)).text;
  } catch (e) {
    logger.warn({ err: e, versionId: ctx.versionId }, 'space summary build failed; continuing without context');
  }
  // S1 常驻指令：按 (lang, projectId, versionId) 查启用 guides（scope 覆盖 version>project>global）。
  // 与 buildSpaceSummary/loadSkills 同款容错：guides 装载失败不能拖垮整个会话工厂。
  let guides: Array<Pick<AssistantGuideRow, 'kind' | 'body'>> = [];
  try {
    guides = await loadActiveGuides({ projectId: ctx.projectId, versionId: ctx.versionId, lang: ctx.lang });
  } catch (e) {
    logger.warn({ err: e, versionId: ctx.versionId }, 'guides 加载失败;继续无 guides 段');
  }
  // S2 catalog：全局 skills 共享库。文件系统即真源——会话建立不做任何写入，只把
  // 「DB enabled 的技能各自的目录绝对路径」交给 loader。传逐技能目录而非 SKILLS_ROOT，
  // pi 的 loadSkills 见到 SKILL.md 即停不再下钻，故停用技能与孤儿目录天然不可见。
  // Skill.location 取 filePath（Skill = { name, description, filePath, baseDir, sourceInfo, ... }）。
  // 与 buildSpaceSummary 同款容错：单条 skill 目录异常（权限/ELOOP）不能拖垮整个会话工厂。
  let skillsFiles: Array<{ name: string; description: string; location: string }> = [];
  let skillPaths: string[] = [];
  try {
    skillPaths = await loadEnabledSkillDirs();
    const res = loadSkills({
      cwd: workspaceDir,
      agentDir: getAgentDir(),
      skillPaths,
      includeDefaults: false,
    });
    if (res.diagnostics.length > 0) {
      logger.warn({ versionId: ctx.versionId, diagnostics: res.diagnostics.map((d) => d.message) }, 'skills 加载有诊断（部分 skill 未装载）');
    }
    skillsFiles = res.skills.map((s) => ({ name: s.name, description: s.description, location: s.filePath }));
  } catch (e) {
    logger.warn({ err: e, versionId: ctx.versionId }, 'skills 加载失败;继续无 skills 段');
  }
  // loader 的 cwd 与 session 工作目录都指向版本独立工作空间（仓库在 ./repo 子目录），
  // 让 AI 对自身所在位置有正确认知，同时避免写入污染仓库检出。
  const loader = new DefaultResourceLoader({
    cwd: workspaceDir,
    agentDir: getAgentDir(),
    additionalSkillPaths: skillPaths,
    appendSystemPromptOverride: (base) => [...base, buildSpaceSystemPrompt(summaryText, ctx.lang, guides)],
    // 每轮开跑前把 preamble 换成产品身份。见 buildSpacePreamble 的注释：不能走
    // loader.systemPrompt，也不能直接改 systemPromptOptions.customPrompt，那两条路都会
    // 丢掉 rules 段里的工具 promptGuidelines。
    extensionFactories: [
      // S2 skills 段自渲染：必须在 MCP 与 identity 之前——identity 渲染 event.systemPrompt（getter，
      // 从共享 currentOptions 重算）并返回 {systemPrompt}，会冻结后续 section 变更；而 skills 段
      // 因 noTools:'builtin' 永远不会被 pi 自己渲染（system-prompt.js:99 门在 read/bash），只能自渲染。
      {
        name: 'itest-space-skills',
        hidden: true,
        factory: (pi) => {
          pi.on('before_agent_start', (event) => {
            event.systemPromptOptions.sections.skills = buildSkillsSectionContent(skillsFiles);
          });
        },
      },
      // MCP：注册 + hermetic 建连装载。必须在 identity 前——identity 的 before_agent_start
      // 渲染 event.systemPrompt（含 mcp_servers 段）并返回 {systemPrompt}，会冻结后续 section 变更。
      mcpExtensions.register,
      mcpExtensions.connect,
      {
        name: 'itest-space-identity',
        hidden: true,
        factory: (pi) => {
          pi.on('before_agent_start', (event) => {
            const rewritten = rewriteSpacePreamble(event.systemPrompt, aiLangFrom(ctx.lang));
            if (rewritten !== undefined) return { systemPrompt: rewritten };
            return undefined;
          });
        },
      },
    ],
  });
  await loader.reload();

  // 恢复优先:piThreadId 非空 → open(文件在则回历史消息,重启后续聊;文件缺失不抛错,
  // pi 内部 newSession 并复用同一路径)。仅 piThreadId 为空或 open 抛错(文件损坏)才 create,
  // 后者降级只记 warn——一条坏文件不该让整个列表接口失败。
  let sessionManager: ReturnType<typeof SessionManager.create>;
  if (ctx.piThreadId) {
    try {
      sessionManager = SessionManager.open(ctx.piThreadId, SESSIONS_ROOT, workspaceDir);
    } catch (err) {
      logger.warn({ err, sessionFile: ctx.piThreadId, threadId: ctx.threadId }, 'pi session open failed; recreating');
      sessionManager = SessionManager.create(workspaceDir, SESSIONS_ROOT);
    }
  } else {
    sessionManager = SessionManager.create(workspaceDir, SESSIONS_ROOT);
  }
  const { session } = await createAgentSession({
    cwd: workspaceDir,
    noTools: 'builtin',
    customTools: tools,
    model,
    sessionManager,
    resourceLoader: loader,
  });

  // bindExtensions 必需：pi 的 session_start 只在 bindExtensions 时触发（agent-session.js:2536）。
  // createMcpExtension 在 session_start 读 pi.getMcpServers() 并后台建连——不 bind 则 MCP 工具永不注册。
  // （Task 1 spike 的核心验证点。若实测 mode:'print' 在 headless 嵌入下行为异常，改传 {} 即可——
  //   ExtensionBindings 全字段可选，mode 只影响 setUIContext。）
  await session.bindExtensions({
    mode: 'print',
    onError: (e) => { logger.warn({ err: e }, 'assistant extension error'); },
  });

  await db.update(aiThreads).set({ piThreadId: session.sessionFile ?? '', updatedAt: new Date() }).where(eq(aiThreads.id, ctx.threadId));
  // Object.assign 而非 spread:AgentSession 的方法在原型上,spread 会丢。
  return Object.assign(session as unknown as SpaceSessionLike, {
    preCompactionMessages: () => preCompactionMessagesOf(sessionManager),
  });
}
