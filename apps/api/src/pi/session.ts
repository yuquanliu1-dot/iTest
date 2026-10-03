/**
 * Per-thread Pi supervisor.
 *
 * 为什么不用 @assistant-ui/react-pi 的 createPiNodeClient？我们的工具需要注入自定义 workspace 工具，
 * 必须直接走 createAgentSession({ customTools, noTools: 'builtin', sessionManager })，而不是
 * 把它当成远程进程。Node 客户端/适配器对自定义工具的支持不直接，所以我们在服务端用 AgentSession，
 * 再用我们自己的 router.ts 把 AgentSession 事件映射到 react-pi 的 HTTP+SSE 契约上。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { aiThreads } from '../db/schema.js';
import { buildWorkspaceTools } from './tools.js';
import { readLlmConfig, type LlmProvider } from './modelBridge.js';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { checkoutRepo, RepoUnavailableError, buildRepoSandboxTools } from './repo.js';
import { recordRepoCheckout } from './workspace.js';

export interface PiSessionLike {
  subscribe(fn: (e: unknown) => void): () => void;
  /** 真实 AgentSession.prompt(text: string, options?)。 */
  prompt(text: string): Promise<void>;
  abort(): void;
  dispose(): Promise<void>;
  /** 真实 AgentSession 是 getter（`get isStreaming()`），只能读不能调用。 */
  readonly isStreaming: boolean;
  messages: unknown[];
  sessionFile: string | undefined;
}

export type SessionFactory = (ctx: {
  threadId: string;
  requirementId: string;
  contextMode: 'repo' | 'page' | 'auto';
  cwd: string | null;
  repoAvailable: boolean;
}) => Promise<PiSessionLike>;

interface ThreadRecord {
  threadId: string;
  requirementId: string;
  session: PiSessionLike;
  listeners: Set<(e: unknown) => void>;
  unsub: () => void;
  /** Per-thread event seq，与 react-pi supervisor 一致：snapshot 用当前值，后续事件先自增再发出。 */
  seq: number;
  /** turn_start 计数（初始 -1，先自增再映射），供 mapSessionEvent 填 turnIndex。 */
  turnIndex: number;
}

const records = new Map<string, ThreadRecord>();

let factory: SessionFactory = createPiSessionFactory;

export function setSessionFactory(f: SessionFactory): void { factory = f; }
export function resetSessions(): void {
  for (const r of records.values()) {
    try { void r.session.dispose(); } catch { /* ignore */ }
    try { r.unsub(); } catch { /* ignore */ }
  }
  records.clear();
}

/** 幂等建线程并加载 Pi session；同 requirementId 复用同一 session。 */
export async function ensureRecord(requirementId: string, opts: { contextMode?: 'repo' | 'page' | 'auto' } = {}): Promise<ThreadRecord> {
  const existing = await db.select().from(aiThreads).where(eq(aiThreads.requirementId, requirementId)).limit(1);
  let threadId: string;
  if (existing[0]) {
    threadId = existing[0].id;
    const cached = records.get(threadId);
    if (cached) return cached;
  } else {
    threadId = randomUUID();
    await db.insert(aiThreads).values({ id: threadId, requirementId, piThreadId: '' });
  }
  // 仓库可用性探测：no_repo（项目未配仓库）静默降级，其它错误抛出。
  // 失败时 cwd=null、repoAvailable=false；后续 buildWorkspaceTools 会走 promptGuidelines 兜底。
  let cwd: string | null = null;
  let repoAvailable = false;
  try {
    cwd = await checkoutRepo(requirementId);
    repoAvailable = true;
    // checkout 成功后把 commit/fetchedAt 写进 workspace doc（右栏「已参考源码 v<sha>」chip 数据源）。
    // best-effort：读 meta / 写 doc 失败不阻塞会话创建。
    try {
      const meta = JSON.parse(await fs.readFile(path.join(cwd, '.itest-sandbox.json'), 'utf8')) as { commit?: string; fetchedAt?: string };
      if (meta.commit) {
        await recordRepoCheckout(requirementId, {
          commit: meta.commit,
          fetchedAt: meta.fetchedAt ?? new Date().toISOString(),
          mode: opts.contextMode === 'repo' ? 'repo' : 'auto',
        });
      }
    } catch { /* doc.repoContext 更新失败不阻塞会话 */ }
  } catch (e) {
    if (!(e instanceof RepoUnavailableError)) throw e;
  }
  const session = await factory({
    threadId,
    requirementId,
    contextMode: opts.contextMode ?? 'auto',
    cwd,
    repoAvailable,
  });
  const rec: ThreadRecord = {
    threadId,
    requirementId,
    session,
    listeners: new Set(),
    unsub: () => { /* assigned below */ },
    seq: 0,
    turnIndex: -1,
  };
  const unsub = session.subscribe((event) => fanOut(rec, event));
  rec.unsub = unsub;
  records.set(threadId, rec);
  return rec;
}

/**
 * Pi AgentSession 事件 → react-pi `PiClientEvent` body 的最小映射。
 * 与 @assistant-ui/react-pi 的 node mapping 保持一致：message_* / tool_execution_* /
 * queue_update / compaction_* 等原样透传；turn_* 由 supervisor 补 turnIndex；
 * agent_start / agent_settled 只保留 type。
 */
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

/** react-pi 客户端事件：`{type:'snapshot', threadId, seq, snapshot}`（snapshot 嵌套）。 */
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
    // 无活跃 session（如重启后未打开）：发一个合法的空快照，避免客户端反复重连报错。
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

/** 供 router 构造 PiThreadSnapshot：活跃 session 返回实时快照，否则 null。 */
export function snapshotOfThread(threadId: string): ThreadSnapshot | null {
  const rec = records.get(threadId);
  return rec ? snapshotOf(rec) : null;
}

/** 线程列表用：活跃 session 返回运行状态；无记录返回 undefined（由调用方给默认 idle）。 */
export function threadStatus(threadId: string): 'running' | 'idle' | undefined {
  const rec = records.get(threadId);
  if (!rec) return undefined;
  return rec.session.isStreaming ? 'running' : 'idle';
}

export async function sendUserMessage(threadId: string, input: { content: string }): Promise<void> {
  const rec = records.get(threadId);
  if (!rec) throw new Error('thread not found');
  // AgentSession.prompt 的签名是 prompt(text: string)，不是 {content}
  await rec.session.prompt(input.content);
}

export function cancelThread(threadId: string): void {
  const rec = records.get(threadId);
  if (!rec) return;
  rec.session.abort();
}

// ─────────────────────────────────────────────────────────────────────────────
// Real factory: 加载 pi-coding-agent + 注入自定义工具
// ─────────────────────────────────────────────────────────────────────────────

/**
 * settings 里的 model 可以是代理/网关的自定义别名（不在 pi-ai catalog 里，getBuiltinModel 返回
 * undefined）。此时按 provider 合成一个最小合法 Model：api 必须是 pi-ai 的 KnownApi 之一，
 * baseUrl 用 settings 的值（网关）或 provider 默认值。
 */
function synthesizeModel(provider: LlmProvider, modelId: string, baseUrl: string | null): Record<string, unknown> {
  const defaults: Record<LlmProvider, { api: string; baseUrl: string }> = {
    anthropic: { api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' },
    openai: { api: 'openai-completions', baseUrl: 'https://api.openai.com/v1' },
    google: { api: 'google-generative-ai', baseUrl: 'https://generativelanguage.googleapis.com' },
  };
  const d = defaults[provider];
  return {
    id: modelId,
    name: modelId,
    api: d.api,
    provider,
    baseUrl: baseUrl ?? d.baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
    type: 'chat',
  };
}

async function createPiSessionFactory(ctx: {
  threadId: string;
  requirementId: string;
  contextMode: 'repo' | 'page' | 'auto';
  cwd: string | null;
  repoAvailable: boolean;
}): Promise<PiSessionLike> {
  const cfg = await readLlmConfig();
  if (!cfg) throw new Error('LLM 未配置：请先到设置页配置模型');
  const { createAgentSession, SessionManager } = await import('@earendil-works/pi-coding-agent');
  const { getBuiltinModel } = await import('@earendil-works/pi-ai/providers/all');
  const workspaceDir = process.env.PI_WORKSPACE_DIR ?? './.data/pi-sessions';
  await import('node:fs/promises').then((fs) => fs.mkdir(workspaceDir, { recursive: true }));

  // 把 repo 工具与 workspace 工具一并注入；defineTool 包法与原样保持一致。
  type ToolRaw = {
    name: string; description: string; parameters: ReturnType<typeof Type.Object>;
    execute: (input: unknown) => Promise<{ ok: true; data?: string } | { ok: false; error: string }>;
    promptGuidelines?: string[];
  };
  // 形如 tools.ts / repo.ts 的 ToolExecutor 形状；声明为局部类型避免循环依赖。
  const ai_toolsRaw: ToolRaw[] = [
    ...buildWorkspaceTools(ctx.requirementId, { contextMode: ctx.contextMode, repoAvailable: ctx.repoAvailable }),
    ...(ctx.repoAvailable && ctx.cwd ? buildRepoSandboxTools(ctx.cwd) : []),
  ];
  const ai_tools = ai_toolsRaw.map((t) =>
    defineTool({
      name: t.name,
      label: t.name,
      description: t.description,
      parameters: t.parameters,
      // inspect_page / repo_* 工具的成功 data（元素清单 / 源码片段）需要回传给模型，不能只回 'ok'
      ...(t.promptGuidelines ? { promptGuidelines: t.promptGuidelines } : {}),
      execute: async (_callId, params, _signal, _onUpdate, _ctx) => {
        const r = await t.execute(params);
        return r.ok
          ? { content: [{ type: 'text', text: r.data ?? 'ok' }], details: undefined }
          : { content: [{ type: 'text', text: r.error }], details: undefined, isError: true };
      },
    }),
  );

  // getBuiltinModel provider-id is a typed literal; cast to satisfy the strict generic
  // (cfg.provider is the runtime validated value, the catalog typing is strict).
  // Catalog miss（自定义别名如 "Auto"）时合成一个最小合法 Model。
  const base = (getBuiltinModel as unknown as (p: string, m: string) => Record<string, unknown> | undefined)(cfg.provider, cfg.model)
    ?? synthesizeModel(cfg.provider, cfg.model, cfg.baseUrl);
  // 凭据：pi-ai 走 ambient env 兜底（ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY），
  // 这里把 settings 里的 key 种进 env；自定义 baseUrl 直接覆盖 catalog model 的 baseUrl。
  const ENV_BY_PROVIDER = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GEMINI_API_KEY' } as const;
  const envKey = ENV_BY_PROVIDER[cfg.provider];
  if (envKey && !process.env[envKey]) process.env[envKey] = cfg.apiKey;
  const model = { ...base, ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}) } as Parameters<typeof createAgentSession>[0] extends infer O ? O extends { model?: infer M } ? M : never : never;

  // 简化：用 in-memory SessionManager；持久化通过 ai_threads.pi_thread_id 在重启时重建。
  const sessionManager = SessionManager.inMemory();

  const { session } = await createAgentSession({
    cwd: ctx.cwd ?? workspaceDir,
    noTools: 'builtin',
    customTools: ai_tools,
    model,
    sessionManager,
  });

  // 把 piThreadId 反向写回（这里用 sessionFile，因为 Pi 用文件作会话标识）
  await db.update(aiThreads).set({ piThreadId: session.sessionFile ?? '', updatedAt: new Date() }).where(eq(aiThreads.id, ctx.threadId));

  return session as unknown as PiSessionLike;
}
