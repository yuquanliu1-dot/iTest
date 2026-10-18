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
import { SKILLS_ROOT, loadEnabledSkills, materializeSkills } from './skillsStore.js';
import { buildMcpExtensionFactory, getMcpServersForThread } from './mcp.js';
import { readLlmConfig, synthesizeModel, ENV_BY_PROVIDER } from '../modelBridge.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { checkoutRepoForVersion, LockTimeoutError, RepoUnavailableError, REPOS_ROOT, WORKSPACES_ROOT } from '../repo.js';
import { emptyRepoState, type RepoState } from './tools/context.js';
import { pendingConfirmPayloads } from './confirm.js';

export interface SpaceSessionLike {
  subscribe(fn: (e: unknown) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): void;
  // pi v0.99.2 的 AgentSession.dispose 是同步 void（agent-session.d.ts:362）；不要 await。
  dispose(): void;
  readonly isStreaming: boolean;
  messages: unknown[];
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
  /** 仓库后台检出状态(与工厂/工具共享同一可变引用)。 */
  repo: RepoState;
  /** 断线重连重放缓冲:emitThreadEvent 追加的会话内自定义事件(条数有界 + TTL 双重上限)。 */
  customEvents: CustomEventRecord[];
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

let factory: SpaceSessionFactory = createSpaceSessionFactory;

export function setSpaceSessionFactory(f: SpaceSessionFactory): void { factory = f; }

export function resetSpaceSessions(): void {
  for (const r of records.values()) {
    // dispose 是同步 void；会话内的 MCP 子进程/thread 生命周期随本进程，reset 不杀它们
    // （进程生命周期内线程常驻，teardown 支撑留给后续需求。见 mcp.ts child-leak deferral）。
    try { r.session.dispose(); } catch { /* ignore */ }
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
  const session = await factory({ threadId, versionId: row.versionId, projectId: v.projectId, repo, createdByUserId: row.createdByUserId, lang, manager });
  const rec: ThreadRecord = {
    threadId,
    versionId: row.versionId,
    session,
    listeners: new Set(),
    unsub: () => { /* assigned below */ },
    seq: 0,
    turnIndex: -1,
    repo,
    customEvents: [],
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
  // 缓冲自定义事件供断线重放。confirm_request 除外——确认卡的挂起协议在 confirm.ts,
  // 由 pending 表重放(只补仍挂起的卡,已处理/超时的不复活,见 subscribeThread)。
  if (e.type !== 'confirm_request') {
    rec.customEvents.push({ publishedAt: Date.now(), ev: stamped });
    if (rec.customEvents.length > MAX_CUSTOM_EVENT_BUFFER) rec.customEvents.shift();
  }
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

/** 线程构建后记录的仓库检出问题(非 no_repo);无 record 或检出未失败返回 null。 */
export function spaceRepoIssue(threadId: string): string | null {
  return records.get(threadId)?.repo.issue ?? null;
}

export async function sendSpaceUserMessage(threadId: string, content: string): Promise<void> {
  const rec = records.get(threadId);
  if (!rec) throw new Error('thread not found');
  // 首条消息落线程标题(取用户原文截断)
  const row = (await db.select({ title: aiThreads.title }).from(aiThreads).where(eq(aiThreads.id, threadId)).limit(1))[0];
  if (row && !row.title) {
    await db.update(aiThreads).set({ title: Array.from(content.trim()).slice(0, 40).join(''), updatedAt: new Date() }).where(eq(aiThreads.id, threadId));
  }
  try {
    await rec.session.prompt(content);
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
  }
}

export function cancelThread(threadId: string): void {
  const rec = records.get(threadId);
  if (!rec) return;
  rec.session.abort();
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
  const workspace = '## 工作空间\n- 当前目录是版本专属工作空间，项目仓库已检出到 ./repo 子目录；读取代码请优先使用 repo_ls / repo_read / repo_grep 工具。';
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
  // S2 catalog：全局 skills 共享库（assistant_skills → .data/skills 物化）。loadSkills 与
  // loader.additionalSkillPaths 同源，会话建立时物化 DB 快照（会话级快照：删改/停用对新线程生效）。
  // Skill.location 取 filePath（Skill = { name, description, filePath, baseDir, sourceInfo, ... }）。
  // 与 buildSpaceSummary 同款容错：物化/单条 skill 目录异常（权限/ELOOP）不能拖垮整个会话工厂。
  let skillsFiles: Array<{ name: string; description: string; location: string }> = [];
  try {
    const stored = await loadEnabledSkills();
    await materializeSkills(stored);
    const res = loadSkills({
      cwd: workspaceDir,
      agentDir: getAgentDir(),
      skillPaths: [SKILLS_ROOT],
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
    additionalSkillPaths: [SKILLS_ROOT],
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

  const sessionManager = SessionManager.inMemory();
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
  return session as unknown as SpaceSessionLike;
}
