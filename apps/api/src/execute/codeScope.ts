/**
 * Code commit scope resolution (the core of exploratory testing's "code commit scope"):
 * charter natural language → LLM intent parsing → git history deepening + window/commit resolution + diff change list → code_scope persisted.
 *
 * Three steps (the common case is a single LLM call):
 *  1. Intent parsing (zero git cost): charter unrelated to commit history → none, git never touched;
 *  2. Fetch history + compute window: deepen the shallow clone (since first, depth as fallback — shallow-boundary coverage must be verified, see
 *     pi/repo.ts ShallowBounds' note: fetch --shallow-since may not rewrite the shallow boundary when objects are already local),
 *     log window filtering, baseline resolution (rev-list --before), numstat/name-status change list;
 *  3. Disambiguation (only when the hint is vague): explicit sha/branch/tag goes straight to rev-parse; vague descriptions (「上个版本」) only then get
 *     a candidate list fed to the LLM to pick; explicit sha missing locally → deepen to 365 days and retry once; still missing = fabricated/out of bounds → failed.
 *
 * Failure semantics: any step throws/times out → failed (soft failure; exploration runs as usual, the session isn't toppled).
 * Scope is a focus signal, not a fence — the parsed result is only used for targeting; it doesn't change exploration's behavioral boundary.
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

// ── Cap constants (material fed back into the next prompt turn cannot grow without bound) ────────────────────
export const SCOPE_TOTAL_BUDGET_MS = 180_000;
const INTENT_TIMEOUT_MS = 60_000;
const DISAMBIG_TIMEOUT_MS = 60_000;
const DEEPEN_MAX_MS = 120_000;
/** Phases no longer start below this remaining budget (deepen/disambiguation can both be slow; starting them wouldn't finish anyway). */
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
/** git empty tree object: when the window covers the repo's entire history the baseline has no real commit; diff is computed from the empty tree (= all content counted as added). */
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** Shape of an explicit sha hint: 6~40 hex chars. Branches/tags go through rev-parse first; only on failure and sha-like shape is it judged "fabricated/out of bounds". */
const SHA_LIKE_RE = /^[0-9a-f]{6,40}$/i;

export type CodeScopeStatus = 'resolved' | 'none' | 'failed';

export interface CodeScopeCommit { sha: string; subject: string; date: string }
export interface CodeScopeFile { path: string; status: string; additions: number; deletions: number }

export interface CodeScope {
  kind: 'time_window' | 'commit_range' | 'single_commit';
  /** Human-readable one-line label (title of the frontend "code scope" card). */
  label: string;
  /** YYYY-MM-DD（time_window）。 */
  since?: string;
  until?: string;
  /** diff baseline → head (used by the repo read channel's diff op). Omitted when the baseline is unavailable. */
  fromSha?: string;
  toSha?: string;
  commitSha?: string;
  headSha?: string;
  commits: CodeScopeCommit[];
  files: CodeScopeFile[];
  /** Candidate entry points (literal /-prefixed path strings extracted from changed files' source) — heuristic, may be inaccurate. */
  hintUrls: string[];
  confidence: number;
  reason: string;
}

export interface ScopeIntent {
  kind: 'none' | 'time_window' | 'commit_range' | 'single_commit';
  /** time_window boundaries (ms). Missing falls back to the default window; a date-only until has been normalized to "end of that day". */
  sinceMs?: number | null;
  untilMs?: number | null;
  sinceDays?: number;
  /** Raw hint text of commit_range / single_commit (sha / branch / tag / vague description). */
  fromHint?: string;
  toHint?: string;
  commitHint?: string;
  confidence: number;
  reason: string;
}

// ── LLM prompts ──────────────────────────────────────────────────────────────

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

// ── Small utilities ──────────────────────────────────────────────────────────

/** Waiting-side timeout: the race rejects as soon as the deadline hits (the underlying promise settling late never becomes unhandledRejection). */
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

/** Date → git explicit timestamp (local timezone YYYY-MM-DDTHH:MM:SS). Bare dates and explicit timestamps judge boundary differently;
 *  the whole chain standardizes on this format (the pi/repo.ts ShallowBounds convention). */
function toGitTs(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Parses an LLM-provided date (YYYY-MM-DD at local-timezone midnight; ISO strings go to Date). The caller normalizes a date-only until. */
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
  // Unknown values are never guessed: treated as "no commit semantics" (conservative direction = zero git cost, exploration still runs the whole site)
  return 'none';
}

/** Intent JSON → shaped intent (alias tolerance for field-name/grading-word drift — the model often writes fields under other names). */
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

// ── git read-only helpers (all via gitRead, 30s timeout; callers guarantee the subcommands are read-only) ──

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

/** Last commit before the window boundary (the unified solution for baseline/toSha). No hit (insufficient history / repo too new) → null. */
async function revListBefore(repoDir: string, ts: string): Promise<string | null> {
  try {
    const out = (await gitRead(repoDir, ['rev-list', '-1', `--before=${ts}`, 'HEAD'])).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** ref (sha/branch/tag/HEAD~n) → 40-char commit sha. Missing/invalid shape → null. */
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

/** Cumulative diff change list: numstat (added/deleted lines) + name-status (A/M/D/R states) stitched best-effort. */
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
    // rename lines are R100\told\tnew: path takes the new name (numstat's rename count format differs; 0 when not found)
    const segs = m[2]!.split('\t');
    const p = segs[segs.length - 1]!;
    if (seen.has(p)) continue;
    seen.add(p);
    const st = stats.get(p) ?? (segs.length > 1 ? stats.get(segs[0]!) : undefined) ?? { additions: 0, deletions: 0 };
    files.push({ path: p, status: m[1]!, additions: st.additions, deletions: st.deletions });
  }
  return files.slice(0, FILES_STORED_MAX);
}

/** Fallback when the baseline is unavailable: aggregate numstat by commit (needs no reachable parent; works even with shallow-boundary truncation). */
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

// ── Candidate entry-point extraction (pure literals, zero LLM, zero invention — heuristic, may be inaccurate, stated plainly in the prompt) ──

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

/** Reads the first 4KB of each changed file to feed extractHintUrls (unreadable deleted files are skipped). */
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
        const head = buf.subarray(0, bytesRead); // only the actually-read bytes — the buffer tail is all zeros; not slicing would misjudge text as binary
        if (head.includes(0)) continue; // binary
        sources.push({ path: f.path, content: head.toString('utf8') });
      } finally {
        await fh.close();
      }
    } catch {
      // Skip unreadable files (deleted / permissions); they don't participate in candidate entry points
    }
  }
  return sources;
}

// ── Hint resolution and disambiguation ───────────────────────────────────────

type EndpointResult = { sha: string } | { needPick: true };

/**
 * Range endpoint resolution: explicit ref goes straight to rev-parse; sha-like but missing locally → deepen to 365 days and retry once,
 * still missing = fabricated/genuinely absent in the repo → null (the whole scope is rejected; a fabricated sha is never taken as real); other vague descriptions → the LLM picks.
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
    // Deepen failure keeps the original hard-fail path (fetch is already running in the background; the lock is released by deepenVersionRepo itself)
  }
  const retry = await resolveRef(repoDir, h);
  return retry ? { sha: retry } : null;
}

/** Vague description → the LLM picks one from the numbered list. No pick (empty picks / out-of-range index / timeout) → null. */
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

// ── Main entry ───────────────────────────────────────────────────────────────

export interface ResolveCodeScopeDeps {
  /** Version workspace directory (default versionWorkspaceDir(versionId)); tests inject a temporary repo. */
  repoDir: string;
  /** History-deepen callback (default deepenVersionRepo(versionId, bounds)); tests inject a no-op (temporary repos have full history). */
  deepen: (bounds: ShallowBounds) => Promise<string>;
  /** LLM client (default resolveLlmClient().client); tests inject a stub. */
  llm: LLMClient;
}

/**
 * Resolves the charter's code commit scope and persists it (code_scope + code_scope_status).
 * Never throws: every failure path lands failed and returns (exploration runs as usual, the session isn't toppled).
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

    // —— Step 1: intent parsing (zero git cost; none short-circuits) ——
    const intentRes = await withTimeout(
      completeJson(client, { systemPrompt: INTENT_SYSTEM_PROMPT, userMessage: input.charter.slice(0, 4000) }),
      INTENT_TIMEOUT_MS,
      '范围意图解析超时',
    );
    const intent = parseIntentValue(intentRes.value);
    logger.info({ sessionId: input.sessionId, kind: intent.kind, confidence: intent.confidence }, 'code scope intent parsed');
    if (intent.kind === 'none') return await finish('none', null);
    if (left() < MIN_PHASE_BUDGET_MS) return await finish('failed', null);

    // —— Step 2: deepen history (since first; on failure one depth-based retry below — the window branch has a
    // second depth fallback for shallow-boundary coverage) ——
    const nowMs = Date.now();
    const windowStartMs = intent.kind === 'time_window'
      ? intent.sinceMs ?? (intent.untilMs ?? nowMs) - (intent.sinceDays ?? DEFAULT_SCOPE_DAYS) * DAY_MS
      : (intent.kind === 'commit_range' ? parseDateInput(intent.fromHint ?? '')?.ms : parseDateInput(intent.commitHint ?? '')?.ms)
        ?? nowMs - DEFAULT_SCOPE_DAYS * DAY_MS;
    const notes: string[] = [];
    try {
      await withTimeout(
        deepen({ since: toGitTs(new Date(windowStartMs - DAY_MS)) }),
        Math.max(MIN_PHASE_BUDGET_MS, Math.min(left(), DEEPEN_MAX_MS)),
        '仓库历史加深超时',
      );
    } catch (e) {
      // Date-windowed deepen fails outright when the shallow tip predates the window start (e.g. the version pins a
      // tag older than the charter's time window → git refuses the boundary rewrite with "error processing shallow
      // info: 4", observed on prod228). Depth-based deepen has no date constraint and rewrites the boundary
      // unconditionally, so retry once with it; if that fails too, let the error propagate (failed, as before).
      await withTimeout(
        deepen({ depth: 500 }),
        Math.max(MIN_PHASE_BUDGET_MS, Math.min(left(), DEEPEN_MAX_MS)),
        '仓库历史加深超时',
      );
      notes.push('按时间加深失败（浅边界早于窗口起点），已改按提交数加深');
    }
    const headSha = await resolveRef(repoDir, 'HEAD');
    if (!headSha) return await finish('failed', null); // repo has no commits or is still unavailable
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
      // Baseline = the last commit before the window start. Shallow boundaries may truncate: shallow and empty baseline → deepen by depth and retry
      // (fetch --shallow-since may not rewrite the shallow boundary when objects are already local; depth always takes effect — see the ShallowBounds note).
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
      if (!fromRes) return await finish('failed', null); // explicit sha still missing after the deepen retry = fabricated/out of bounds
      if (!toRes) return await finish('failed', null);
      if ('needPick' in fromRes || 'needPick' in toRes) {
        // At least one endpoint vague → the LLM picks from the local list
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
        // Endpoint order normalized: older → fromSha, newer → toSha (so the diff direction is right)
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
        return await finish('failed', null); // explicit sha still missing after the deepen retry = fabricated/out of bounds
      } else {
        const listed = (await gitLogCommits(repoDir, [])).slice(0, COMMITS_TO_LLM_MAX);
        if (listed.length === 0) return await finish('failed', null);
        const picked = await pickCommitSha(client, listed, hint.trim() || '章程描述的那次提交（清单里最贴近的一个）');
        if (!picked) return await finish('failed', null);
        commitSha = picked;
      }
      toSha = commitSha;
      // Single-commit diff baseline = parent commit; parent not local (root commit / shallow boundary cut exactly at the parent) → aggregate-by-commit fallback
      fromSha = (await resolveRef(repoDir, `${commitSha}~1`)) ?? undefined;
      commits = await gitLogCommits(repoDir, ['-1', commitSha]);
      files = fromSha ? await diffFiles(repoDir, fromSha, toSha) : await aggregateLogFiles(repoDir, ['-1', commitSha]);
    }

    // —— Candidate entry points (heuristic) + persist ——
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
