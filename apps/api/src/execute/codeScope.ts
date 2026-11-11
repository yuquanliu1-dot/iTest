/**
 * 代码提交范围解析（探索式测试「代码提交范围」的核心）：
 * charter 自然语言 → LLM 意图解析 → git 历史加深 + 窗口/提交解析 + diff 改动清单 → code_scope 落库。
 *
 * 三步（常见情况只有一次 LLM 调用）：
 *  1. 意图解析（无 git 成本）：charter 与提交历史无关 → none，绝不碰 git；
 *  2. 取历史 + 算窗口：加深浅克隆（since 优先、depth 兜底——浅边界覆盖度必须核验，见
 *     pi/repo.ts ShallowBounds 的注明：fetch --shallow-since 在对象已在本地时可能不重写浅边界）、
 *     log 窗口过滤、基线解析（rev-list --before）、numstat/name-status 改动清单；
 *  3. 消歧（仅当线索含糊）：显式 sha/分支/标签直接 rev-parse，含糊描述（「上个版本」）才喂
 *     候选清单让 LLM 选；显式 sha 本地不存在 → 加深到 365 天重试一次，仍没有 = 编造/越界 → failed。
 *
 * 失败语义：任何一步抛错/超时 → failed（软失败，探索照常跑，会话不掀翻）。
 * 范围是焦点信号不是围栏——解析结果只用于定向，不改变探索的行为边界。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { explorationSessions } from '../db/schema.js';
import { completeJson, type LLMClient } from '../agent/llm-client.js';
import { resolveLlmClient } from '../agent/llmSettings.js';
import { gitRead, deepenVersionRepo, versionWorkspaceDir, type ShallowBounds } from '../pi/repo.js';
import { logger } from '../logger.js';

// ── 封顶常量（回灌进下一轮提示词的物料不能无限膨胀）────────────────────────────
export const SCOPE_TOTAL_BUDGET_MS = 180_000;
const INTENT_TIMEOUT_MS = 60_000;
const DISAMBIG_TIMEOUT_MS = 60_000;
const DEEPEN_MAX_MS = 120_000;
/** 剩余预算低于此值不再开启新阶段（deepen/消歧都可能很慢，开了也完不成）。 */
const MIN_PHASE_BUDGET_MS = 30_000;
const DEFAULT_SCOPE_DAYS = 90;
const DAY_MS = 86_400_000;
const LOG_MAX_COUNT = 200;
const COMMITS_TO_LLM_MAX = 120;
const COMMITS_STORED_MAX = 60;
const FILES_STORED_MAX = 200;
const HINTURL_FILES_MAX = 20;
const HINTURL_FILE_BYTES = 4096;
const HINTURLS_MAX = 10;
/** git 空树对象：窗口覆盖仓库全部历史时基线没有真提交，diff 从空树算（= 全部内容视作新增）。 */
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** 显式 sha 线索的形状：6~40 位十六进制。分支/标签先走 rev-parse，失败且长得像 sha 才判「编造/越界」。 */
const SHA_LIKE_RE = /^[0-9a-f]{6,40}$/i;

export type CodeScopeStatus = 'resolved' | 'none' | 'failed';

export interface CodeScopeCommit { sha: string; subject: string; date: string }
export interface CodeScopeFile { path: string; status: string; additions: number; deletions: number }

export interface CodeScope {
  kind: 'time_window' | 'commit_range' | 'single_commit';
  /** 给人看的一行标签（前端「代码范围」卡片的标题）。 */
  label: string;
  /** YYYY-MM-DD（time_window）。 */
  since?: string;
  until?: string;
  /** diff 基线 → 头（repo 读码通道的 diff op 用这两个）。基线不可得时缺省。 */
  fromSha?: string;
  toSha?: string;
  commitSha?: string;
  headSha?: string;
  commits: CodeScopeCommit[];
  files: CodeScopeFile[];
  /** 候选起点（从改动文件源码里抽的以 / 开头的字面量路径串）——启发式，可能不准。 */
  hintUrls: string[];
  confidence: number;
  reason: string;
}

export interface ScopeIntent {
  kind: 'none' | 'time_window' | 'commit_range' | 'single_commit';
  /** time_window 窗口边界（毫秒）。缺失按默认窗口兜底；date-only 的 until 已归一成「当日末」。 */
  sinceMs?: number | null;
  untilMs?: number | null;
  sinceDays?: number;
  /** commit_range / single_commit 的原始线索文本（sha / 分支 / 标签 / 含糊描述）。 */
  fromHint?: string;
  toHint?: string;
  commitHint?: string;
  confidence: number;
  reason: string;
}

// ── LLM 提示词 ────────────────────────────────────────────────────────────────

const INTENT_SYSTEM_PROMPT = `你是测试平台的「代码提交范围」解析器。给你一段探索式测试的章程（charter），判断它是否要求把探索焦点对准某段代码提交历史（如「最近一个月提交的功能」「某两个提交之间的改动」「某个提交引入的问题」）。
只输出 JSON，不要输出其他内容：
{"intent":"none|time_window|commit_range|single_commit","confidence":<0~1>,"reason":"<一句话依据>"}
- none：与提交历史无关，探索全站即可（绝大多数章程属于此类）
- time_window：按时间窗口聚焦。附加字段二选一：sinceDays=<相对天数数字>（如「最近一个月」→30），或 sinceDate/untilDate=<YYYY-MM-DD>（可只给其一）
- commit_range：按提交区间聚焦。附加字段：fromHint/toHint=<区间两端点的自然语言描述>（可能是 sha、分支名、标签、日期、「上个版本」等）
- single_commit：聚焦单个提交。附加字段：commitHint=<该提交的 sha 或描述>
不确定就给 none 并在 reason 里说明，宁缺毋滥。`;

const DISAMBIG_SYSTEM_PROMPT = `你是 git 提交消歧器。给你一段对提交的自然语言描述和一个编号提交清单（按时间从新到旧）。从清单里选出最符合描述的那一个提交。
只输出 JSON：{"picks":[<序号>]}（序号 1 起，恰好一个）。清单里没有符合描述的提交 → {"picks":[]}。`;

// ── 小工具 ────────────────────────────────────────────────────────────────────

/** 等待侧超时：竞速到点即抛错（底层 promise 迟到 settle 不会变 unhandledRejection）。 */
async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function pickStr(o: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function pickNum(o: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/** Date → git 显式时间戳（本地时区 YYYY-MM-DDTHH:MM:SS）。裸日期与显式时间戳的边界判定不同，
 *  全链路统一走这个格式（pi/repo.ts ShallowBounds 的约定）。 */
function toGitTs(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 解析 LLM 给的日期（YYYY-MM-DD 按本地时区零点；ISO 串交给 Date）。date-only 的 until 由调用方归一。 */
function parseDateInput(s: string): { ms: number; text: string; dateOnly: boolean } | null {
  const t = s.trim();
  if (!t) return null;
  const dm = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(t);
  if (dm) {
    const d = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]));
    if (isNaN(d.getTime())) return null;
    return { ms: d.getTime(), text: `${dm[1]}-${dm[2]!.padStart(2, '0')}-${dm[3]!.padStart(2, '0')}`, dateOnly: true };
  }
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : { ms: d.getTime(), text: t, dateOnly: false };
}

function normalizeIntent(raw: string): ScopeIntent['kind'] {
  const s = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!s || s === 'none' || s === 'no' || s === 'null' || s === '无' || s === '无关' || s === '不涉及') return 'none';
  if (['time_window', 'time', 'window', 'date_range', '时间窗口', '时间', '时间段', '日期', '最近'].includes(s)) return 'time_window';
  if (['commit_range', 'range', 'commits', '提交区间', '提交范围', '区间'].includes(s)) return 'commit_range';
  if (['single_commit', 'single', 'commit', '单个提交', '单提交', '提交'].includes(s)) return 'single_commit';
  // 未知值不猜：按「无提交语义」处理（保守方向 = 零 git 成本，探索照常全站跑）
  return 'none';
}

/** 意图 JSON → 形状化意图（字段名/判级词漂移的别名容错——模型常把字段写成别的名字）。 */
export function parseIntentValue(value: Record<string, unknown>): ScopeIntent {
  const kind = normalizeIntent(pickStr(value, ['intent', 'kind', 'type', 'mode', '意图', '类型']));
  const confidenceRaw = pickNum(value, ['confidence', '置信度', '把握']);
  const out: ScopeIntent = {
    kind,
    confidence: confidenceRaw === null ? 0.5 : Math.min(1, Math.max(0, confidenceRaw)),
    reason: pickStr(value, ['reason', '依据', '原因', '说明']).slice(0, 200),
  };
  if (kind === 'time_window') {
    const days = pickNum(value, ['sinceDays', 'days', 'lastDays', 'recentDays', '最近天数', '天数']);
    if (days !== null && days >= 1 && days <= 3650) out.sinceDays = Math.round(days);
    const since = parseDateInput(pickStr(value, ['sinceDate', 'since', 'startDate', '开始日期', '起始日期']));
    if (since) out.sinceMs = since.ms;
    const until = parseDateInput(pickStr(value, ['untilDate', 'until', 'endDate', '结束日期']));
    if (until) out.untilMs = until.dateOnly ? until.ms + DAY_MS - 1 : until.ms;
  } else if (kind === 'commit_range') {
    out.fromHint = pickStr(value, ['fromHint', 'from', 'startRef', 'base', '起点', '起始提交']) || undefined;
    out.toHint = pickStr(value, ['toHint', 'to', 'endRef', 'head', '终点', '目标提交']) || undefined;
  } else if (kind === 'single_commit') {
    out.commitHint = pickStr(value, ['commitHint', 'commit', 'sha', 'ref', '提交', '提交号']) || undefined;
  }
  return out;
}

// ── git 只读辅助（全部走 gitRead，30s 超时；调用方负责保证子命令只读）──────────

async function gitLogCommits(repoDir: string, extraArgs: string[]): Promise<CodeScopeCommit[]> {
  const out = await gitRead(repoDir, ['log', `--max-count=${LOG_MAX_COUNT}`, '--date=iso', '--pretty=format:%H%x1f%ad%x1f%s', ...extraArgs]);
  const commits: CodeScopeCommit[] = [];
  for (const line of out.split('\n')) {
    const parts = line.split('\x1f');
    if (parts.length < 3 || !parts[0]) continue;
    commits.push({ sha: parts[0], date: (parts[1] ?? '').trim(), subject: parts.slice(2).join('\x1f').slice(0, 120) });
  }
  return commits;
}

/** 窗口边界前最后一个提交（基线/toSha 的统一解法）。无命中（历史不足/仓库太新）→ null。 */
async function revListBefore(repoDir: string, ts: string): Promise<string | null> {
  try {
    const out = (await gitRead(repoDir, ['rev-list', '-1', `--before=${ts}`, 'HEAD'])).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** ref（sha/分支/标签/HEAD~n）→ 40 位 commit sha。不存在/形状非法 → null。 */
async function resolveRef(repoDir: string, ref: string): Promise<string | null> {
  const s = ref.trim();
  if (!s || /\s/.test(s) || s.length > 200) return null;
  try {
    const out = (await gitRead(repoDir, ['rev-parse', '--verify', '--end-of-options', `${s}^{commit}`])).trim();
    return /^[0-9a-f]{40}$/i.test(out) ? out : null;
  } catch {
    return null;
  }
}

async function isShallow(repoDir: string): Promise<boolean> {
  return fs.stat(path.join(repoDir, '.git', 'shallow')).then(() => true).catch(() => false);
}

async function commitTime(repoDir: string, sha: string): Promise<number> {
  try {
    return Number((await gitRead(repoDir, ['show', '-s', '--format=%ct', sha])).trim()) || 0;
  } catch {
    return 0;
  }
}

/** 累计 diff 的改动清单：numstat（增删行数）+ name-status（A/M/D/R 状态）best-effort 拼接。 */
async function diffFiles(repoDir: string, from: string, to: string): Promise<CodeScopeFile[]> {
  const [numstatRaw, statusRaw] = await Promise.all([
    gitRead(repoDir, ['diff', '--numstat', from, to]),
    gitRead(repoDir, ['diff', '--name-status', from, to]),
  ]);
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const line of numstatRaw.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    stats.set(m[3]!, { additions: m[1] === '-' ? 0 : Number(m[1]), deletions: m[2] === '-' ? 0 : Number(m[2]) });
  }
  const files: CodeScopeFile[] = [];
  const seen = new Set<string>();
  for (const line of statusRaw.split('\n')) {
    const m = /^([A-Z])\d*\t(.+)$/.exec(line.trim());
    if (!m) continue;
    // rename 行是 R100\told\tnew：path 取新名（numstat 的 rename 计数格式不同，查不到就 0）
    const segs = m[2]!.split('\t');
    const p = segs[segs.length - 1]!;
    if (seen.has(p)) continue;
    seen.add(p);
    const st = stats.get(p) ?? (segs.length > 1 ? stats.get(segs[0]!) : undefined) ?? { additions: 0, deletions: 0 };
    files.push({ path: p, status: m[1]!, additions: st.additions, deletions: st.deletions });
  }
  return files.slice(0, FILES_STORED_MAX);
}

/** 基线不可得时的兜底：按提交聚合 numstat（不需要父提交可达，浅边界截断也能算出局部清单）。 */
async function aggregateLogFiles(repoDir: string, extraArgs: string[]): Promise<CodeScopeFile[]> {
  const out = await gitRead(repoDir, ['log', '--numstat', '--pretty=format:%x00', ...extraArgs]);
  const agg = new Map<string, CodeScopeFile>();
  for (const block of out.split('\x00')) {
    for (const line of block.split('\n')) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (!m) continue;
      const p = m[3]!;
      const prev = agg.get(p) ?? { path: p, status: 'M', additions: 0, deletions: 0 };
      prev.additions += m[1] === '-' ? 0 : Number(m[1]);
      prev.deletions += m[2] === '-' ? 0 : Number(m[2]);
      agg.set(p, prev);
    }
  }
  return [...agg.values()].slice(0, FILES_STORED_MAX);
}

// ── 候选起点抽取（纯字面量，零 LLM 零臆造——启发式，可能不准，提示词里明说）────

const STATIC_ASSET_RE = /\.(png|jpe?g|gif|bmp|svg|ico|woff2?|ttf|otf|eot|pdf|zip|gz|tar|mp4|mp3|webm|map|lock)$/i;
const QUOTED_PATH_RE = /['"`](\/[A-Za-z0-9_\-.\/:@[\]]{1,80})['"`]/g;

export function extractHintUrls(sources: Array<{ path: string; content: string }>): string[] {
  const out: string[] = [];
  for (const src of sources) {
    if (STATIC_ASSET_RE.test(src.path)) continue;
    for (const m of src.content.matchAll(QUOTED_PATH_RE)) {
      const p = m[1]!;
      if (p === '/' || p.includes('*') || p.includes('//')) continue;
      if (/\.(js|mjs|cjs|css|scss|less|json|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|map)$/i.test(p)) continue;
      if (/^\/(dev|tmp|usr|etc|var|home|opt|root|proc|sys)\b/.test(p)) continue;
      if (!out.includes(p)) out.push(p);
      if (out.length >= HINTURLS_MAX) return out;
    }
  }
  return out;
}

/** 改动文件的头 4KB 读出来喂 extractHintUrls（deleted 文件读不到就跳过）。 */
async function readSourceHeads(repoDir: string, files: CodeScopeFile[]): Promise<Array<{ path: string; content: string }>> {
  const sources: Array<{ path: string; content: string }> = [];
  for (const f of files) {
    if (sources.length >= HINTURL_FILES_MAX) break;
    if (STATIC_ASSET_RE.test(f.path)) continue;
    if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i.test(f.path)) continue;
    try {
      const fh = await fs.open(path.join(repoDir, f.path), 'r');
      try {
        const buf = Buffer.alloc(HINTURL_FILE_BYTES);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        if (bytesRead === 0) continue;
        const head = buf.subarray(0, bytesRead); // 只看实读字节——缓冲区尾部全是 0，不切会把文本误判成二进制
        if (head.includes(0)) continue; // 二进制
        sources.push({ path: f.path, content: head.toString('utf8') });
      } finally {
        await fh.close();
      }
    } catch {
      // 文件读不到就跳过（deleted / 权限），不参与候选起点
    }
  }
  return sources;
}

// ── 线索解析与消歧 ────────────────────────────────────────────────────────────

type EndpointResult = { sha: string } | { needPick: true };

/**
 * 区间端点解析：显式 ref 直接 rev-parse；长得像 sha 但本地没有 → 加深到 365 天重试一次，
 * 仍没有 = 编造/仓库里真没有 → null（拒绝整个范围，不把编造 sha 当真）；其余含糊描述 → 交 LLM 选。
 */
async function resolveEndpoint(
  repoDir: string,
  hint: string,
  deepen: (b: ShallowBounds) => Promise<string>,
  left: () => number,
  notes: string[],
): Promise<EndpointResult | null> {
  const h = hint.trim();
  if (!h) return { needPick: true };
  const direct = await resolveRef(repoDir, h);
  if (direct) return { sha: direct };
  if (!SHA_LIKE_RE.test(h)) return { needPick: true };
  try {
    await withTimeout(
      deepen({ since: toGitTs(new Date(Date.now() - 365 * DAY_MS)) }),
      Math.max(MIN_PHASE_BUDGET_MS, Math.min(left(), DEEPEN_MAX_MS)),
      '仓库历史加深超时',
    );
    notes.push('线索指向更早历史，已加深到 365 天');
  } catch {
    // 加深失败按原路径继续判死（fetch 已在后台跑，锁由 deepenVersionRepo 自行释放）
  }
  const retry = await resolveRef(repoDir, h);
  return retry ? { sha: retry } : null;
}

/** 含糊描述 → LLM 从编号清单里选一个。选不出（空 picks / 越界序号 / 超时）→ null。 */
async function pickCommitSha(client: LLMClient, listed: CodeScopeCommit[], hint: string): Promise<string | null> {
  const lines = listed.map((c, i) => `${i + 1}. ${c.sha.slice(0, 10)} ${(c.date || '').slice(0, 10)} ${c.subject}`);
  try {
    const r = await withTimeout(
      completeJson(client, {
        systemPrompt: DISAMBIG_SYSTEM_PROMPT,
        userMessage: `描述：${hint}\n\n提交清单（新→旧）：\n${lines.join('\n')}`,
      }),
      DISAMBIG_TIMEOUT_MS,
      '提交消歧超时',
    );
    const picks = Array.isArray(r.value.picks) ? r.value.picks : [];
    const n = Number(picks[0]);
    if (!Number.isInteger(n) || n < 1 || n > listed.length) return null;
    return listed[n - 1]!.sha;
  } catch (e) {
    logger.warn({ err: e, hint: hint.slice(0, 60) }, 'code scope commit pick failed');
    return null;
  }
}

// ── 主入口 ────────────────────────────────────────────────────────────────────

export interface ResolveCodeScopeDeps {
  /** 版本工作树目录（缺省 versionWorkspaceDir(versionId)）；测试注入临时仓库。 */
  repoDir: string;
  /** 历史加深回调（缺省 deepenVersionRepo(versionId, bounds)）；测试注入 no-op（临时仓库全量历史）。 */
  deepen: (bounds: ShallowBounds) => Promise<string>;
  /** LLM 客户端（缺省 resolveLlmClient().client）；测试注入桩。 */
  llm: LLMClient;
}

/**
 * 解析 charter 的代码提交范围并落库（code_scope + code_scope_status）。
 * 永不抛错：任何失败路径都落 failed 后返回（探索照常跑，会话不掀翻）。
 */
export async function resolveCodeScope(
  input: { sessionId: string; charter: string; versionId: string },
  deps?: Partial<ResolveCodeScopeDeps>,
): Promise<{ status: CodeScopeStatus; scope?: CodeScope }> {
  const t0 = Date.now();
  const left = (): number => SCOPE_TOTAL_BUDGET_MS - (Date.now() - t0);
  const repoDir = deps?.repoDir ?? versionWorkspaceDir(input.versionId);
  const deepen = deps?.deepen ?? ((bounds: ShallowBounds) => deepenVersionRepo(input.versionId, bounds));
  const finish = async (status: CodeScopeStatus, scope: CodeScope | null): Promise<{ status: CodeScopeStatus; scope?: CodeScope }> => {
    try {
      await db
        .update(explorationSessions)
        .set({ codeScope: scope, codeScopeStatus: status, updatedAt: new Date() })
        .where(eq(explorationSessions.id, input.sessionId));
    } catch (e) {
      logger.warn({ err: e, sessionId: input.sessionId }, 'code scope persist failed');
    }
    return scope ? { status, scope } : { status };
  };
  try {
    const client = deps?.llm ?? (await resolveLlmClient()).client;

    // —— 第 1 步：意图解析（无 git 成本；none 即短路）——
    const intentRes = await withTimeout(
      completeJson(client, { systemPrompt: INTENT_SYSTEM_PROMPT, userMessage: input.charter.slice(0, 4000) }),
      INTENT_TIMEOUT_MS,
      '范围意图解析超时',
    );
    const intent = parseIntentValue(intentRes.value);
    logger.info({ sessionId: input.sessionId, kind: intent.kind, confidence: intent.confidence }, 'code scope intent parsed');
    if (intent.kind === 'none') return await finish('none', null);
    if (left() < MIN_PHASE_BUDGET_MS) return await finish('failed', null);

    // —— 第 2 步：加深历史（since 优先；覆盖度核验不足时 depth 兜底在窗口分支里做）——
    const nowMs = Date.now();
    const windowStartMs = intent.kind === 'time_window'
      ? intent.sinceMs ?? (intent.untilMs ?? nowMs) - (intent.sinceDays ?? DEFAULT_SCOPE_DAYS) * DAY_MS
      : (intent.kind === 'commit_range' ? parseDateInput(intent.fromHint ?? '')?.ms : parseDateInput(intent.commitHint ?? '')?.ms)
        ?? nowMs - DEFAULT_SCOPE_DAYS * DAY_MS;
    await withTimeout(
      deepen({ since: toGitTs(new Date(windowStartMs - DAY_MS)) }),
      Math.max(MIN_PHASE_BUDGET_MS, Math.min(left(), DEEPEN_MAX_MS)),
      '仓库历史加深超时',
    );
    const headSha = await resolveRef(repoDir, 'HEAD');
    if (!headSha) return await finish('failed', null); // 仓库无提交或仍不可用

    const notes: string[] = [];
    let fromSha: string | undefined;
    let toSha: string | undefined;
    let commitSha: string | undefined;
    let commits: CodeScopeCommit[] = [];
    let files: CodeScopeFile[] = [];
    let sinceText: string | undefined;
    let untilText: string | undefined;

    if (intent.kind === 'time_window') {
      const sinceMs = intent.sinceMs ?? (intent.untilMs ?? nowMs) - (intent.sinceDays ?? DEFAULT_SCOPE_DAYS) * DAY_MS;
      const untilMs = intent.untilMs ?? nowMs;
      const sinceTs = toGitTs(new Date(sinceMs));
      const untilExclTs = toGitTs(new Date(untilMs + 60_000));
      // 基线 = 窗口起点前最后一个提交。浅边界可能截断：shallow 且基线为空 → depth 兜底加深再试
      // （fetch --shallow-since 在对象已在本地时可能不重写浅边界，depth 恒生效——见 ShallowBounds 注明）。
      let baseline = await revListBefore(repoDir, sinceTs);
      if (!baseline && (await isShallow(repoDir))) {
        await withTimeout(
          deepen({ depth: 500 }),
          Math.max(MIN_PHASE_BUDGET_MS, Math.min(left(), DEEPEN_MAX_MS)),
          '仓库历史加深超时',
        );
        baseline = await revListBefore(repoDir, sinceTs);
        notes.push('浅边界覆盖不足，已按提交数加深');
      }
      if (baseline) {
        fromSha = baseline;
      } else if (!(await isShallow(repoDir))) {
        fromSha = EMPTY_TREE_SHA;
        notes.push('窗口覆盖仓库全部历史，基线为空树');
      } else {
        notes.push('浅边界截断，基线不可得，改动清单按提交聚合（可能不完整）');
      }
      toSha = (await revListBefore(repoDir, untilExclTs)) ?? headSha;
      commits = await gitLogCommits(repoDir, [`--after=${sinceTs}`, `--before=${untilExclTs}`]);
      files = fromSha && toSha ? await diffFiles(repoDir, fromSha, toSha) : await aggregateLogFiles(repoDir, [`--after=${sinceTs}`, `--before=${untilExclTs}`]);
      sinceText = fmtDate(new Date(sinceMs));
      untilText = fmtDate(new Date(untilMs));
    } else if (intent.kind === 'commit_range') {
      const fromRes = await resolveEndpoint(repoDir, intent.fromHint ?? '', deepen, left, notes);
      const toRes = intent.toHint?.trim() ? await resolveEndpoint(repoDir, intent.toHint, deepen, left, notes) : { sha: headSha };
      if (!fromRes) return await finish('failed', null); // 显式 sha 加深重试后仍不存在 = 编造/越界
      if (!toRes) return await finish('failed', null);
      if ('needPick' in fromRes || 'needPick' in toRes) {
        // 至少一端含糊 → LLM 从本地清单选
        const listed = (await gitLogCommits(repoDir, [])).slice(0, COMMITS_TO_LLM_MAX);
        if (listed.length === 0) return await finish('failed', null);
        if ('needPick' in fromRes) {
          const sha = await pickCommitSha(client, listed, intent.fromHint?.trim() || '章程描述的改动起点提交（清单里最贴近的一个）');
          if (!sha) return await finish('failed', null);
          fromSha = sha;
        } else if (fromRes) {
          fromSha = fromRes.sha;
        }
        if ('needPick' in toRes) {
          const sha = await pickCommitSha(client, listed, intent.toHint?.trim() || '章程描述的改动终点提交（清单里最贴近的一个）');
          if (!sha) return await finish('failed', null);
          toSha = sha;
        } else if (toRes) {
          toSha = toRes.sha;
        }
        if (fromSha === toSha) return await finish('failed', null);
        // 端点次序归一：旧 → fromSha，新 → toSha（diff 方向才对）
        if (await commitTime(repoDir, fromSha!) > await commitTime(repoDir, toSha!)) {
          [fromSha, toSha] = [toSha!, fromSha!];
        }
      } else {
        fromSha = fromRes.sha;
        toSha = toRes.sha;
      }
      commits = await gitLogCommits(repoDir, [`${fromSha}..${toSha}`]);
      files = await diffFiles(repoDir, fromSha!, toSha!);
    } else {
      const hint = intent.commitHint ?? '';
      const direct = hint.trim() ? await resolveEndpoint(repoDir, hint, deepen, left, notes) : ({ needPick: true } as const);
      if (direct && 'sha' in direct) {
        commitSha = direct.sha;
      } else if (direct === null) {
        return await finish('failed', null); // 显式 sha 加深重试后仍不存在 = 编造/越界
      } else {
        const listed = (await gitLogCommits(repoDir, [])).slice(0, COMMITS_TO_LLM_MAX);
        if (listed.length === 0) return await finish('failed', null);
        const picked = await pickCommitSha(client, listed, hint.trim() || '章程描述的那次提交（清单里最贴近的一个）');
        if (!picked) return await finish('failed', null);
        commitSha = picked;
      }
      toSha = commitSha;
      // 单提交的 diff 基线 = 父提交；父不在本地（根提交/浅边界刚好截在父上）→ 按提交聚合兜底
      fromSha = (await resolveRef(repoDir, `${commitSha}~1`)) ?? undefined;
      commits = await gitLogCommits(repoDir, ['-1', commitSha]);
      files = fromSha ? await diffFiles(repoDir, fromSha, toSha) : await aggregateLogFiles(repoDir, ['-1', commitSha]);
    }

    // —— 候选起点（启发式）+ 落库 ——
    const hintUrls = extractHintUrls(await readSourceHeads(repoDir, files));
    let label: string;
    if (intent.kind === 'time_window') {
      label = intent.sinceDays ? `最近 ${intent.sinceDays} 天` : `${sinceText} ~ ${untilText}`;
    } else if (intent.kind === 'commit_range') {
      label = `${fromSha!.slice(0, 8)}..${toSha!.slice(0, 8)}`;
    } else {
      label = `${commitSha!.slice(0, 8)} ${commits[0]?.subject.slice(0, 30) ?? ''}`.trim();
    }
    const scope: CodeScope = {
      kind: intent.kind,
      label,
      ...(sinceText ? { since: sinceText } : {}),
      ...(untilText ? { until: untilText } : {}),
      ...(fromSha ? { fromSha } : {}),
      ...(toSha ? { toSha } : {}),
      ...(commitSha ? { commitSha } : {}),
      headSha,
      commits: commits.slice(0, COMMITS_STORED_MAX),
      files,
      hintUrls,
      confidence: intent.confidence,
      reason: [intent.reason, ...notes].filter(Boolean).join('；').slice(0, 300),
    };
    return await finish('resolved', scope);
  } catch (e) {
    logger.warn({ err: e, sessionId: input.sessionId }, 'code scope resolve failed');
    return await finish('failed', null);
  }
}
