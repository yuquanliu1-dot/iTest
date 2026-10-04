/**
 * 版本空间 AI 助手线程 supervisor(pi/space)。
 * 与 requirement 级 pi/session.ts 并列:绑定 versionId、一线程一 session、一版本可多线程。
 * 事件→react-pi 契约的映射与 pi/session.ts 保持一致;上下文摘要经 system prompt 注入(session 创建时)。
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { aiThreads, projectVersions } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { buildSpaceTools } from './tools/index.js';
import { buildSpaceSummary } from './summary.js';
import { readLlmConfig } from '../modelBridge.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { checkoutRepoForVersion, RepoUnavailableError } from '../repo.js';
import { synthesizeModel, ENV_BY_PROVIDER } from '../session.js';

export interface SpaceSessionLike {
  subscribe(fn: (e: unknown) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): void;
  dispose(): Promise<void>;
  readonly isStreaming: boolean;
  messages: unknown[];
}

export interface SpaceThreadContext {
  threadId: string;
  versionId: string;
  projectId: string;
  cwd: string | null;
  repoAvailable: boolean;
}

export type SpaceSessionFactory = (ctx: SpaceThreadContext) => Promise<SpaceSessionLike>;

interface ThreadRecord {
  threadId: string;
  versionId: string;
  session: SpaceSessionLike;
  listeners: Set<(e: unknown) => void>;
  unsub: () => void;
  seq: number;
  turnIndex: number;
  /** 非 no_repo 的仓库不可用原因说明(auth_failed 等);null = 正常或未配仓库(no_repo 静默)。 */
  repoIssue: string | null;
}

const records = new Map<string, ThreadRecord>();
const inflight = new Map<string, Promise<ThreadRecord>>();

let factory: SpaceSessionFactory = createSpaceSessionFactory;

export function setSpaceSessionFactory(f: SpaceSessionFactory): void { factory = f; }

export function resetSpaceSessions(): void {
  for (const r of records.values()) {
    r.session.dispose().catch(() => { /* ignore */ });
    try { r.unsub(); } catch { /* ignore */ }
  }
  records.clear();
  inflight.clear();
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

  // repo 探测:no_repo 完全静默;其它失败 session 照常建立(repoAvailable=false),
  // 原因记在 record 上由 router 随建线程响应透出(前端黄条警告,不阻断对话)
  let cwd: string | null = null;
  let repoAvailable = false;
  let repoIssue: string | null = null;
  try {
    cwd = await checkoutRepoForVersion(row.versionId);
    repoAvailable = true;
  } catch (e) {
    if (!(e instanceof RepoUnavailableError)) throw e;
    if (e.reason !== 'no_repo') repoIssue = `${e.message}(${e.reason})`;
  }

  const session = await factory({ threadId, versionId: row.versionId, projectId: v.projectId, cwd, repoAvailable });
  const rec: ThreadRecord = {
    threadId,
    versionId: row.versionId,
    session,
    listeners: new Set(),
    unsub: () => { /* assigned below */ },
    seq: 0,
    turnIndex: -1,
    repoIssue,
  };
  const unsub = session.subscribe((event) => fanOut(rec, event));
  rec.unsub = unsub;
  records.set(threadId, rec);
  return rec;
}

/** Pi AgentSession 事件 → react-pi body 的最小映射(与 pi/session.ts 一致)。 */
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

function fanOut(rec: ThreadRecord, event: unknown): void {
  const raw = event as { type?: string } & Record<string, unknown>;
  if (raw.type === 'turn_start') rec.turnIndex += 1;
  const body = mapSessionEvent(raw, { turnIndex: rec.turnIndex });
  rec.seq += 1;
  const stamped = { ...body, threadId: rec.threadId, seq: rec.seq };
  for (const fn of rec.listeners) {
    try { fn(stamped); } catch { /* listener errors do not break the supervisor */ }
  }
}

/** 工具侧向线程 SSE 订阅者广播自定义事件(confirm_request 等);无活跃 session 时静默丢弃。 */
export function emitThreadEvent(threadId: string, e: Record<string, unknown>): void {
  const rec = records.get(threadId);
  if (!rec) return;
  rec.seq += 1;
  const stamped = { ...e, threadId, seq: rec.seq };
  for (const fn of rec.listeners) {
    try { fn(stamped); } catch { /* ignore */ }
  }
}

export interface ThreadSnapshot {
  metadata: { id: string; status: 'running' | 'idle'; messageCount: number };
  messages: unknown[];
}

export function snapshotOf(rec: ThreadRecord): ThreadSnapshot {
  return {
    metadata: {
      id: rec.threadId,
      status: rec.session.isStreaming ? 'running' : 'idle',
      messageCount: rec.session.messages.length,
    },
    messages: rec.session.messages,
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
    fn(snapshotEventOf(rec.threadId, rec.seq, snapshotOf(rec)));
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

/** 线程构建时记录的仓库问题(非 no_repo);无 record 或无问题返回 null。 */
export function spaceRepoIssue(threadId: string): string | null {
  return records.get(threadId)?.repoIssue ?? null;
}

export async function sendSpaceUserMessage(threadId: string, content: string): Promise<void> {
  const rec = records.get(threadId);
  if (!rec) throw new Error('thread not found');
  // 首条消息落线程标题(取用户原文截断)
  const row = (await db.select({ title: aiThreads.title }).from(aiThreads).where(eq(aiThreads.id, threadId)).limit(1))[0];
  if (row && !row.title) {
    await db.update(aiThreads).set({ title: Array.from(content.trim()).slice(0, 40).join(''), updatedAt: new Date() }).where(eq(aiThreads.id, threadId));
  }
  await rec.session.prompt(content);
}

export function cancelThread(threadId: string): void {
  const rec = records.get(threadId);
  if (!rec) return;
  rec.session.abort();
}

// ─────────────────────────────────────────────────────────────────────────────
// Real factory:注入空间工具(Plan 1 = repo 沙箱)并建 AgentSession
// ─────────────────────────────────────────────────────────────────────────────

/** 空间助手 system prompt:风格约束 + 版本上下文摘要;无摘要时仅风格段(resourceLoader 追加空段无副作用)。 */
export function buildSpaceSystemPrompt(summaryText: string | null): string {
  const style = '## 输出风格\n- 不要使用 emoji;强调用 markdown 加粗,列举用列表/表格。';
  if (!summaryText) return style;
  return `${style}\n\n## 版本空间上下文\n${summaryText}`;
}

async function createSpaceSessionFactory(ctx: SpaceThreadContext): Promise<SpaceSessionLike> {
  const cfg = await readLlmConfig();
  if (!cfg) {
    throw new HttpError(502, 'llm_not_configured', 'LLM 未配置:请先到设置页配置模型');
  }
  const { createAgentSession, SessionManager, DefaultResourceLoader, getAgentDir } = await import('@earendil-works/pi-coding-agent');
  const { getBuiltinModel } = await import('@earendil-works/pi-ai/providers/all');
  const workspaceDir = process.env.PI_WORKSPACE_DIR ?? './.data/pi-sessions';
  await import('node:fs/promises').then((fs) => fs.mkdir(workspaceDir, { recursive: true }));

  type ToolRaw = {
    name: string; description: string; parameters: ReturnType<typeof Type.Object>;
    execute: (input: unknown) => Promise<{ ok: true; data?: string } | { ok: false; error: string }>;
    promptGuidelines?: string[];
  };
  const rawTools: ToolRaw[] = buildSpaceTools({ ...ctx, emit: (e) => emitThreadEvent(ctx.threadId, e) }) as ToolRaw[];
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
  const loader = new DefaultResourceLoader({
    cwd: ctx.cwd ?? workspaceDir,
    agentDir: getAgentDir(),
    appendSystemPromptOverride: (base) => [...base, buildSpaceSystemPrompt(summaryText)],
  });
  await loader.reload();

  const sessionManager = SessionManager.inMemory();
  const { session } = await createAgentSession({
    cwd: ctx.cwd ?? workspaceDir,
    noTools: 'builtin',
    customTools: tools,
    model,
    sessionManager,
    resourceLoader: loader,
  });

  await db.update(aiThreads).set({ piThreadId: session.sessionFile ?? '', updatedAt: new Date() }).where(eq(aiThreads.id, ctx.threadId));
  return session as unknown as SpaceSessionLike;
}
