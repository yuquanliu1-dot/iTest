/**
 * Per-thread Pi supervisor.
 *
 * 为什么不用 @assistant-ui/react-pi 的 createPiNodeClient？我们的工具需要注入自定义 workspace 工具，
 * 必须直接走 createAgentSession({ customTools, noTools: 'builtin', sessionManager })，而不是
 * 把它当成远程进程。Node 客户端/适配器对自定义工具的支持不直接，所以我们在服务端用 AgentSession，
 * 再用我们自己的 router.ts 把 AgentSession 事件映射到 react-pi 的 HTTP+SSE 契约上。
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { aiThreads } from '../db/schema.js';
import { buildWorkspaceTools } from './tools.js';
import { readLlmConfig } from './modelBridge.js';
import { defineTool } from '@earendil-works/pi-coding-agent';

export interface PiSessionLike {
  subscribe(fn: (e: unknown) => void): () => void;
  prompt(input: { content: string }): Promise<void>;
  abort(): void;
  dispose(): Promise<void>;
  isStreaming(): boolean;
  messages: unknown[];
  sessionFile: string | undefined;
}

export type SessionFactory = (ctx: { threadId: string; requirementId: string }) => Promise<PiSessionLike>;

interface ThreadRecord {
  threadId: string;
  requirementId: string;
  session: PiSessionLike;
  listeners: Set<(e: unknown) => void>;
  unsub: () => void;
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
export async function ensureRecord(requirementId: string): Promise<ThreadRecord> {
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
  const session = await factory({ threadId, requirementId });
  const rec: ThreadRecord = {
    threadId,
    requirementId,
    session,
    listeners: new Set(),
    unsub: () => { /* assigned below */ },
  };
  const unsub = session.subscribe((event) => fanOut(rec, event));
  rec.unsub = unsub;
  records.set(threadId, rec);
  return rec;
}

let seqCounter = 0;
function fanOut(rec: ThreadRecord, event: unknown): void {
  seqCounter += 1;
  const stamped = { ...(event as Record<string, unknown>), threadId: rec.threadId, seq: seqCounter };
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
      status: rec.session.isStreaming() ? 'running' : 'idle',
      messageCount: rec.session.messages.length,
    },
    messages: rec.session.messages,
  };
}

export function subscribeThread(
  threadId: string,
  fn: (e: unknown) => void,
  opts: { includeSnapshot?: boolean } = {},
): () => void {
  const rec = records.get(threadId);
  if (!rec) throw new Error('thread not found');
  if (opts.includeSnapshot === true) {
    fn({ ...snapshotOf(rec), seq: 0 });
  }
  rec.listeners.add(fn);
  return () => { rec.listeners.delete(fn); };
}

export async function sendUserMessage(threadId: string, input: { content: string }): Promise<void> {
  const rec = records.get(threadId);
  if (!rec) throw new Error('thread not found');
  await rec.session.prompt(input);
}

export function cancelThread(threadId: string): void {
  const rec = records.get(threadId);
  if (!rec) return;
  rec.session.abort();
}

// ─────────────────────────────────────────────────────────────────────────────
// Real factory: 加载 pi-coding-agent + 注入自定义工具
// ─────────────────────────────────────────────────────────────────────────────

async function createPiSessionFactory(ctx: { threadId: string; requirementId: string }): Promise<PiSessionLike> {
  const cfg = await readLlmConfig();
  if (!cfg) throw new Error('LLM 未配置：请先到设置页配置模型');
  const { createAgentSession, SessionManager } = await import('@earendil-works/pi-coding-agent');
  const { getBuiltinModel } = await import('@earendil-works/pi-ai/providers/all');

  const workspaceDir = process.env.PI_WORKSPACE_DIR ?? './.data/pi-sessions';
  await import('node:fs/promises').then((fs) => fs.mkdir(workspaceDir, { recursive: true }));

  const ai_tools = buildWorkspaceTools(ctx.requirementId).map((t) =>
    defineTool({
      name: t.name,
      label: t.name,
      description: t.description,
      parameters: t.parameters,
      execute: async (_callId, params, _signal, _onUpdate, _ctx) => {
        const r = await t.execute(params);
        return r.ok
          ? { content: [{ type: 'text', text: 'ok' }], details: undefined }
          : { content: [{ type: 'text', text: r.error }], details: undefined, isError: true };
      },
    }),
  );

  // getBuiltinModel provider-id is a typed literal; cast to satisfy the strict generic
  // (cfg.provider is the runtime validated value, the catalog typing is strict).
  const model = (getBuiltinModel as unknown as (p: string, m: string) => unknown)(cfg.provider, cfg.model) as Parameters<typeof createAgentSession>[0] extends infer O ? O extends { model?: infer M } ? M : never : never;

  // 简化：用 in-memory SessionManager；持久化通过 ai_threads.pi_thread_id 在重启时重建。
  const sessionManager = SessionManager.inMemory();

  const { session } = await createAgentSession({
    cwd: workspaceDir,
    noTools: 'builtin',
    customTools: ai_tools,
    model,
    sessionManager,
  });

  // 把 piThreadId 反向写回（这里用 sessionFile，因为 Pi 用文件作会话标识）
  await db.update(aiThreads).set({ piThreadId: session.sessionFile ?? '', updatedAt: new Date() }).where(eq(aiThreads.id, ctx.threadId));

  return session as unknown as PiSessionLike;
}
