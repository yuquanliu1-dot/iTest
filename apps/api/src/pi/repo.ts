import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { Type } from '@earendil-works/pi-ai';
// @ts-expect-error proper-lockfile ships no .d.ts; lock/release signature is obvious
import lockfile from 'proper-lockfile';
import { db } from '../db/client.js';
import { projects, projectVersions, requirements } from '../db/schema.js';
import { analyzeLocatorCandidatesBatch, type SourceCount } from '../execute/staticLocator.js';
import type { Locator } from '@itest/shared';
import type { ToolExecutor } from './tools.js';

export const DATA_DIR = process.env.PI_DATA_DIR ?? path.resolve(process.cwd(), '.data');
export const REPOS_ROOT = path.join(DATA_DIR, 'repos');
export const WORKSPACES_ROOT = path.join(DATA_DIR, 'workspaces');
export const REPO_LOCK_TIMEOUT_MS = 5_000;

/** Lock wait budget for the deepen path. Persona-matrix sessions on the same version start at the same
 *  instant and all deepen the SAME workspace — the winner legitimately runs a real deepen for tens of
 *  seconds, so the siblings must queue behind it instead of failing with LockTimeoutError after ~6s
 *  (observed on prod228: a 2-persona matrix instant-failed the second session's code-scope resolution
 *  while the first was still deepening). The codeScope phase budget (withTimeout 30–120s per attempt)
 *  still bounds the total wait; by the time a sibling acquires the lock its own fetch is a cheap no-op
 *  (objects already local). The assistant checkout path (depth-1, seconds) keeps the fail-fast default. */
const DEEPEN_LOCK_WAIT_MS = 90_000;
export const REPO_RUN_TIMEOUT_MS = 30_000;
export const MAX_OUTPUT_CHARS = 30_000;
export const MAX_REPO_ENTRIES = 500;
export const DEFAULT_READ_MAX_LINES = 200;
export const READ_MAX_LINES_HARD_CAP = 500;

const WHITELIST_TOP = new Set(['ls', 'cat', 'tree', 'find', 'head', 'tail', 'wc', 'grep', 'rg', 'git']);
const WHITELIST_GIT_SUBCMD = new Set(['log', 'show', 'diff', 'ls-files', 'grep', 'status']);
const BLOCKED_CHARS = /[;&|`$()<>\n\r]/;

export type RepoUnavailableReason = 'no_repo' | 'clone_failed' | 'auth_failed' | 'dirty' | 'fetch_failed';

export class RepoUnavailableError extends Error {
  constructor(public reason: RepoUnavailableReason, message: string) { super(message); this.name = 'RepoUnavailableError'; }
}
export class SandboxViolationError extends Error {
  constructor(message: string) { super(message); this.name = 'SandboxViolationError'; }
}
export class LockTimeoutError extends Error {
  constructor(message: string) { super(message); this.name = 'LockTimeoutError'; }
}

/** Safely serialize any result into a data string (truncated to MAX_OUTPUT_CHARS). */
function asData(payload: unknown): string {
  const s = JSON.stringify(payload);
  return s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + '…(truncated)' : s;
}

/** Resolves a user-supplied path to an absolute path; after realpath it must startsWith cwdRoot.
 *  Escapes always throw SandboxViolationError; the caller owns the try/catch and returns { ok: false, error }. */
export async function assertInCwd(cwdRoot: string, target: string): Promise<string> {
  if (!target || typeof target !== 'string') {
    throw new SandboxViolationError('path is empty');
  }
  const abs = path.isAbsolute(target) ? target : path.join(cwdRoot, target);
  const real = await fs.realpath(abs).catch(() => abs);
  const rootReal = await fs.realpath(cwdRoot);
  // Append the trailing separator so /foo/barbaz is not misjudged as a substring of /foo/bar
  const rootWithSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  if (real !== rootReal && !real.startsWith(rootWithSep)) {
    throw new SandboxViolationError(`path escapes cwd: ${target}`);
  }
  return real;
}

function runRg(cwdRoot: string, args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('rg', args, { cwd: cwdRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('rg timeout')); }, REPO_RUN_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // code=1 means no matches (rg convention) — still a success
      if (code === 0 || code === 1) resolve({ stdout: out, code });
      reject(new Error(`rg exited ${code}: ${err}`));
    });
  });
}

/** cwdRoot takes a static directory (requirement level) or () => string (dynamically resolved,
 *  space-level background async checkout: throws when not ready/unavailable, and each tool's
 *  existing try/catch turns that into an error result). */

/** Per-pattern count: the one-by-one query path of L1 static locating (batch version: countRepoGrepBatch).
 *  -c outputs path:count per file, so output size is bounded by "matched file count" rather than
 *  "matched line count"; --max-count=100 caps the per-file count (even a hyper-generic anchor cannot
 *  blow up the output). rg honors .gitignore by default.
 *  Kept for callers needing a separate glob or a single exact count. */
export async function countRepoGrep(cwdRoot: string, pattern: string, glob?: string): Promise<SourceCount> {
  const args = ['--no-heading', '-c', '-S', '--max-count=100'];
  if (glob) args.push('--glob', glob);
  args.push('--', pattern, '.');
  const { stdout } = await runRg(cwdRoot, args);
  if (!stdout) return { count: 0, truncated: false, samplePaths: [] };
  let count = 0;
  let truncated = false;
  const samplePaths: string[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split('\n').filter(Boolean)) {
    const idx = line.lastIndexOf(':');
    const pathPart = idx > 0 ? line.slice(0, idx) : line;
    const cnt = Number(line.slice(idx + 1));
    if (!Number.isFinite(cnt)) continue;
    if (cnt >= 100) truncated = true;
    count += cnt;
    if (!seen.has(pathPart) && samplePaths.length < 10) {
      seen.add(pathPart);
      samplePaths.push(pathPart);
    }
  }
  return { count, truncated, samplePaths };
}

/** Per-file line cap for batch mode. Note rg's --max-count is "per file" not "per pattern";
 *  N patterns share this quota (measured: 300 files × 2 patterns, cap=2 → exactly 600 lines). */
const BATCH_MAX_COUNT_PER_FILE = 200;
/** Total output line cap for batch mode, preventing common-word patterns (service/test/data) from flooding memory.
 *  Exceeding it truncates and sets truncated on everything — the count only feeds the unique/multiple/none
 *  three-way split, and truncation only inflates the count (toward multiple); it never misjudges multiple as unique. */
const BATCH_MAX_TOTAL_LINES = 20_000;
/** Max sample paths recorded per pattern in batch mode (aligned with countRepoGrep). */
const BATCH_MAX_SAMPLE_PATHS = 10;

/** Attributes rg -n's merged output per pattern into perPattern (accumulated in place).
 *  rg does not label which -e a hit came from, so whole original lines are fetched and each
 *  pattern's compiled regex claims them in memory. */
function attributeLines(
  stdout: string,
  regexes: Array<{ pattern: string; re: RegExp }>,
  perPattern: Map<string, SourceCount>,
): void {
  let lineNo = 0;
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    if (++lineNo > BATCH_MAX_TOTAL_LINES) {
      for (const sc of perPattern.values()) sc.truncated = true;
      break;
    }
    // rg -n outputs path:lineno:text. When the path contains colons, locate the split point by the "first colon followed by a digit" shape.
    const m = /^([^:]+):(\d+):([\s\S]*)$/.exec(line);
    if (!m) continue;
    const text = m[3]!;
    for (const { pattern, re } of regexes) {
      if (!re.test(text)) continue;
      const sc = perPattern.get(pattern)!;
      sc.count += 1;
      if (!sc.samplePaths.includes(m[1]!) && sc.samplePaths.length < BATCH_MAX_SAMPLE_PATHS) {
        sc.samplePaths.push(m[1]!);
      }
    }
  }
}

/** Batch-query N patterns: walk the tree once, attribute per pattern on the JS side.
 *
 *  rg's merged output does not label which -e a hit came from, and analyzeLocatorCandidates'
 *  verdict (unique / multiple / not-found) depends on per-pattern counts, so -n line mode fetches
 *  whole original lines and attributeLines attributes them.
 *  N patterns × thousands of lines ≈ tens of thousands of regex.test calls — milliseconds, not a bottleneck.
 *  Do not make the spawns concurrent: rg already parallelizes by core count; adding outer concurrency
 *  only fights over the same CPUs (measured slower).
 *
 *  Patterns are grouped by "contains uppercase or not", one rg run each — the reason is that
 *  rg -S (smart-case) applies to **the whole command line, not a single -e**: as soon as any
 *  pattern on the command line contains uppercase, rg disables case-insensitivity for all patterns.
 *  Measured (real repo / SOC base-all):
 *    -S -e placeholder              → 2288 (including 180 variants like placeHolderStyle)
 *    -S -e placeholder -e searchForm → 2108 (searchForm has uppercase, dragging placeholder into case-sensitive)
 *  A mixed run necessarily makes one group disagree with the per-pattern version; after splitting,
 *  patterns within each run's smart-case scope are homogeneous and the attribution regexes use
 *  their group's case semantics (the no-uppercase group adds the i flag), strictly aligned with
 *  the per-pattern version.
 *  After grouping there are at most 2 spawns — still an order of magnitude better than N serial runs. */
export async function countRepoGrepBatch(cwdRoot: string, patterns: string[]): Promise<Map<string, SourceCount>> {
  const out = new Map<string, SourceCount>();
  const uniq = [...new Set(patterns)].filter(Boolean);
  if (uniq.length === 0) return out;

  const groups = [
    uniq.filter((p) => !/[A-Z]/.test(p)),
    uniq.filter((p) => /[A-Z]/.test(p)),
  ].filter((g) => g.length > 0);

  for (const group of groups) {
    const insensitive = !/[A-Z]/.test(group[0]!);
    // The attribution regexes all come from extractGrepKeys' esc() (escaping . * + ? ^ $ { } ( ) | [ ] \),
    // so they always compile — no per-pattern try/catch.
    const regexes = group.map((p) => ({ pattern: p, re: new RegExp(p, insensitive ? 'i' : '') }));
    const perPattern = new Map<string, SourceCount>(
      group.map((p) => [p, { count: 0, truncated: false, samplePaths: [] }]),
    );
    const argList = ['--no-heading', '-n', '-S', `--max-count=${BATCH_MAX_COUNT_PER_FILE}`];
    for (const p of group) argList.push('-e', p);
    argList.push('--', '.');
    // rg unavailable/timeout → record 0 hits for the whole batch (static analysis is advisory; never
    // interrupt verify_case over a tool failure; same leniency toward rg errors as the per-pattern
    // version). perPattern is pre-seeded with 0 counts, so both success and failure merge into out.
    await runRg(cwdRoot, argList)
      .then(({ stdout }) => attributeLines(stdout, regexes, perPattern))
      .catch(() => undefined);
    for (const [p, sc] of perPattern) {
      const prev = out.get(p);
      if (prev) {
        prev.count += sc.count;
        prev.truncated = prev.truncated || sc.truncated;
        for (const s of sc.samplePaths) {
          if (prev.samplePaths.length < BATCH_MAX_SAMPLE_PATHS && !prev.samplePaths.includes(s)) prev.samplePaths.push(s);
        }
      } else {
        out.set(p, sc);
      }
    }
  }
  return out;
}

export function buildRepoSandboxTools(cwdRoot: string | (() => string)): ToolExecutor[] {
  const resolveCwd = (): string => (typeof cwdRoot === 'function' ? cwdRoot() : cwdRoot);
  return [
    {
      name: 'repo_ls',
      description: '列出已检出项目仓库根目录下某目录的文件与子目录（不含隐藏文件）。最多 500 项。',
      parameters: Type.Object({
        path: Type.Optional(Type.String()),
      }),
      execute: async (input) => {
        const { path: p } = input as { path?: string };
        try {
          const real = await assertInCwd(resolveCwd(), p ?? '.');
          const entries = await fs.readdir(real, { withFileTypes: true });
          const list = entries
            .filter((e) => !e.name.startsWith('.'))
            .slice(0, MAX_REPO_ENTRIES)
            .map((e) => ({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file' }));
          return { ok: true, data: asData({ entries: list, truncated: entries.length > MAX_REPO_ENTRIES }) };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      },
    },
    {
      name: 'repo_read',
      description: '读取已检出项目仓库根目录下文本文件的指定行范围（默认前 200 行，最多 500 行）。',
      parameters: Type.Object({
        path: Type.String({ minLength: 1 }),
        offset: Type.Optional(Type.Number({ minimum: 0 })),
        maxLines: Type.Optional(Type.Number({ minimum: 1 })),
      }),
      execute: async (input) => {
        const { path: p, offset = 0, maxLines = DEFAULT_READ_MAX_LINES } = input as { path: string; offset?: number; maxLines?: number };
        const cap = Math.min(maxLines, READ_MAX_LINES_HARD_CAP);
        try {
          const real = await assertInCwd(resolveCwd(), p);
          const stat = await fs.stat(real);
          if (!stat.isFile()) return { ok: false, error: 'not a file' };
          const fh = await fs.open(real, 'r');
          try {
            const head = Buffer.alloc(Math.min(512, stat.size));
            await fh.read(head, 0, head.length, 0);
            if (head.includes(0)) return { ok: false, error: 'binary file' };
            const all = await fh.readFile('utf8');
            const hasTrailingNl = all.endsWith('\n');
            const rawLines = all.split('\n');
            const lines = hasTrailingNl ? rawLines.slice(0, -1) : rawLines;
            const sliced = lines.slice(offset, offset + cap);
            const joined = sliced.join('\n');
            const slice = hasTrailingNl ? joined + '\n' : joined;
            return {
              ok: true,
              data: asData({
                content: slice.length > MAX_OUTPUT_CHARS ? slice.slice(0, MAX_OUTPUT_CHARS) + '…(truncated)' : slice,
                totalLines: lines.length,
                truncated: lines.length > offset + cap,
              }),
            };
          } finally { await fh.close(); }
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      },
    },
    {
      name: 'repo_grep',
      description: '在已检出项目仓库根目录下用 ripgrep 搜索；输出形如 file:line:text。maxMatches 默认 200。',
      parameters: Type.Object({
        pattern: Type.String({ minLength: 1 }),
        glob: Type.Optional(Type.String()),
        maxMatches: Type.Optional(Type.Number({ minimum: 1 })),
      }),
      execute: async (input) => {
        const { pattern, glob, maxMatches = 200 } = input as { pattern: string; glob?: string; maxMatches?: number };
        const args = ['--no-heading', '-n', '-S', `--max-count=${maxMatches}`];
        if (glob) args.push('--glob', glob);
        args.push('--', pattern, '.');
        try {
          const { stdout } = await runRg(resolveCwd(), args);
          if (!stdout) return { ok: true, data: asData({ matches: [] }) };
          const lines = stdout.split('\n').filter(Boolean);
          const matches = lines.map((l) => {
            const idx1 = l.indexOf(':');
            const idx2 = idx1 >= 0 ? l.indexOf(':', idx1 + 1) : -1;
            if (idx1 < 0 || idx2 < 0) return { raw: l };
            return { path: l.slice(0, idx1), line: Number(l.slice(idx1 + 1, idx2)), text: l.slice(idx2 + 1) };
          });
          return { ok: true, data: asData({ matches, truncated: matches.length >= maxMatches }) };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      },
    },
    {
      name: 'static_locator',
      description: '对一组候选 locator 做源码静态定位分析：逐候选查询该锚点字面量在仓库源码中的命中次数，返回 verdict（unique=源码唯一锚点 / multiple=源码命中多处→回放歧义风险 / not-found=源码未字面命中且无语义键（疑似臆造或改名）/ dynamic-suspect=源码未字面命中但存在动态绑定（如 :placeholder="变量"），运行时为准，勿据此判死 / skipped=无静态可判）。locator 证据存疑时自主使用（源码静态分析是取证渠道）；元素存在性与执行成败仍以 verify_case 实测反馈为准。确认存在后用于修正 compiled 步骤的 locator：把伪唯一锚点（如 [title="查看"] 源码命中多处）换成语义唯一锚点（如 .icon-chakan）。',
      parameters: Type.Object({
        locators: Type.Array(Type.Object({ strategy: Type.String({ minLength: 1 }), value: Type.String({ minLength: 1 }) })),
      }),
      execute: async (input) => {
        const { locators } = input as { locators: Array<{ strategy: string; value: string }> };
        try {
          const cwd = resolveCwd();
          const reports = await analyzeLocatorCandidatesBatch(locators as Locator[], (patterns) => countRepoGrepBatch(cwd, patterns));
          return { ok: true, data: asData(reports) };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      },
    },
    {
      name: 'repo_run',
      description: '在已检出项目仓库根目录下执行白名单单命令；用于 git log/show/diff/ls-files/grep/status 等二级需求。',
      parameters: Type.Object({
        command: Type.String({ minLength: 1, maxLength: 1024 }),
      }),
      execute: async (input) => {
        const { command } = input as { command: string };
        if (BLOCKED_CHARS.test(command)) {
          return { ok: false, error: 'shell metacharacters not allowed' };
        }
        const parts = command.trim().split(/\s+/);
        const top = parts[0]!;
        if (!WHITELIST_TOP.has(top)) return { ok: false, error: `command not whitelisted: ${top}` };
        if (top === 'git') {
          const sub = parts[1];
          if (!sub || !WHITELIST_GIT_SUBCMD.has(sub)) {
            return { ok: false, error: `git subcommand not whitelisted: ${sub ?? '(none)'}` };
          }
        }
        try {
          const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
            const child = spawn(top, parts.slice(1), { cwd: resolveCwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '';
            let err = '';
            const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('command timeout')); }, REPO_RUN_TIMEOUT_MS);
            child.stdout.on('data', (d) => { out += d.toString(); });
            child.stderr.on('data', (d) => { err += d.toString(); });
            child.on('error', (e) => { clearTimeout(t); reject(e); });
            child.on('close', (c) => { clearTimeout(t); resolve({ stdout: out, stderr: err, code: typeof c === 'number' ? c : -1 }); });
          });
          const ok = code === 0;
          const result: { ok: true; data?: string } | { ok: false; error: string } = ok
            ? { ok: true, data: stdout.slice(0, MAX_OUTPUT_CHARS) }
            : { ok: false, error: `exit ${code}${stderr ? ': ' + stderr.trim().slice(0, 200) : ''}` };
          return result;
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      },
    },
  ];
}

interface ProjectRepo { repoUrl: string; branch: string; provider: string; pat: string | null; gitlabOverride: string | null; }

async function loadProjectRepo(requirementId: string): Promise<ProjectRepo | null> {
  const row = (await db
    .select({
      repoUrl: projects.repoUrl,
      branch: projects.defaultBranch,
      provider: projects.provider,
      pat: projects.patOverride,
      gitlabOverride: projects.gitlabUrlOverride,
    })
    .from(requirements)
    .innerJoin(projects, eq(requirements.projectId, projects.id))
    .where(eq(requirements.id, requirementId))
    .limit(1))[0];
  if (!row || !row.repoUrl) return null;
  return { repoUrl: row.repoUrl, branch: row.branch, provider: row.provider, pat: row.pat, gitlabOverride: row.gitlabOverride };
}

function injectPat(url: string, provider: string, pat: string | null, gitlabOverride: string | null): string {
  if (!pat) return url;
  if (provider === 'github') {
    const u = new URL(url);
    u.username = 'x-access-token';
    u.password = pat;
    return u.toString();
  }
  if (provider === 'gitee') {
    const u = new URL(url);
    u.username = 'oauth2';
    u.password = pat;
    return u.toString();
  }
  // gitlab
  const base = gitlabOverride ?? url;
  const u = new URL(base);
  u.username = 'oauth2';
  u.password = pat;
  return u.toString();
}

async function dirExists(p: string): Promise<boolean> {
  return fs.stat(p).then((s) => s.isDirectory()).catch(() => false);
}

function runGit(args: string[], cwdArg: string = process.cwd(), timeoutMs?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: cwdArg, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    // Timeout applies to read-side calls only (gitRead): checkout/deepen are long operations, deliberately untimed; a hung read command must be breakable.
    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs) {
      timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`git timeout after ${timeoutMs}ms`)); }, timeoutMs);
    }
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => {
      const errNo = e as NodeJS.ErrnoException;
      // When the container image lacks git, spawn fails with ENOENT; the raw "spawn git ENOENT"
      // gives ops no guidance, so convert it into an actionable fix hint; checkoutInBackground
      // propagates it further into repo.issue.
      if (timer) clearTimeout(timer);
      if (errNo.code === 'ENOENT' && errNo.message.includes('git')) {
        reject(new Error('git binary missing in runtime image; rebuild infra/docker/api.Dockerfile with git installed'));
      } else {
        reject(errNo);
      }
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(err.trim() || `git exit ${code}`));
    });
  });
}

function runGitIn(cwdArg: string, args: string[]): Promise<string> {
  return runGit(args, cwdArg);
}

/** Entry point for read-only git calls (shared by exploration's "code commit scope" resolution and
 *  the code-reading channel).
 *  The caller guarantees the subcommand is read-only (log/diff/show/rev-list…); no whitelist here.
 *  30s timeout (a hung read command must be breakable; checkout/deepen use the internal runGit, untimed). */
export async function gitRead(cwdArg: string, args: string[]): Promise<string> {
  return runGit(args, cwdArg, REPO_RUN_TIMEOUT_MS);
}

/** Shallow-clone bounds: depth by commit count, since by date (mutually exclusive — git refuses both at once).
 *  Default depth=1 → zero behavior change on the assistant path.
 *  since must be an explicit timestamp (YYYY-MM-DDTHH:MM:SS): a bare date "2026-01-01" and
 *  "2026-01-01T00:00:00" judge the boundary differently (measured; only the latter strictly includes
 *  same-day commits), so callers always pass explicit timestamps.
 *  Note fetch --shallow-since may not rewrite the shallow boundary when objects are already local
 *  (deepened once, then truncated back to depth 1 by the assistant) — the caller must verify
 *  coverage itself and retry with depth when insufficient (depth always takes effect). */
export interface ShallowBounds {
  /** Depth (commit count). */
  depth?: number;
  /** Shallow-bound timestamp (explicit YYYY-MM-DDTHH:MM:SS): fetches history after that moment. */
  since?: string;
}

const DEFAULT_SHALLOW_DEPTH = 1;

/** Shallow-clone arg group for git clone/fetch: since takes priority over depth (git forbids both at once). */
function shallowArgs(bounds: ShallowBounds): string[] {
  return bounds.since
    ? ['--shallow-since', bounds.since]
    : ['--depth', String(bounds.depth ?? DEFAULT_SHALLOW_DEPTH)];
}

async function cloneFirst(target: string, info: ProjectRepo, bounds: ShallowBounds): Promise<void> {
  try {
    await runGit(['clone', ...shallowArgs(bounds), '--branch', info.branch, injectPat(info.repoUrl, info.provider, info.pat, info.gitlabOverride), target]);
  } catch (e) {
    await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    const msg = (e as Error).message;
    const reason: RepoUnavailableReason = /401|403|auth/i.test(msg) ? 'auth_failed' : 'clone_failed';
    throw new RepoUnavailableError(reason, msg);
  }
}

async function fetchAndReset(target: string, info: ProjectRepo, ref: string, bounds: ShallowBounds = {}): Promise<string> {
  // 1. dirty check: tracked modifications / untracked files → stash
  const status = await runGitIn(target, ['status', '--porcelain']).catch(() => '');
  let stashRef: string | null = null;
  if (status.trim().length > 0) {
    const stashOut = await runGitIn(target, ['stash', 'push', '--include-untracked', '-m', `itest-auto-${Date.now()}`]);
    stashRef = stashOut.match(/refs\/stash\{\d+\}/)?.[0] ?? stashOut.trim();
  }
  // 2. fetch + reset (FETCH_HEAD works for both branch and tag)
  try {
    await runGitIn(target, ['fetch', ...shallowArgs(bounds), 'origin', ref]);
    await runGitIn(target, ['reset', '--hard', 'FETCH_HEAD']);
  } catch (e) {
    const msg = (e as Error).message;
    throw new RepoUnavailableError(/401|403/i.test(msg) ? 'auth_failed' : 'fetch_failed', msg);
  }
  // 3. Write meta (branch records the actual ref)
  const commit = (await runGitIn(target, ['rev-parse', 'HEAD'])).trim();
  await fs.writeFile(path.join(target, '.itest-sandbox.json'), JSON.stringify({
    provider: info.provider,
    branch: ref,
    commit,
    fetchedAt: new Date().toISOString(),
    ...(stashRef ? { stashRef } : {}),
  }, null, 2));
  return target;
}

/** Directory lock: same target directory → same lock (proper-lockfile's lock file is the sibling path
 *  `<target>.lock`, so rm -rf target inside the lock does not destroy the lock itself). Checkout and
 *  "deepen shallow clone" share it → the two actions never stomp each other. */
async function withRepoLock<T>(target: string, fn: () => Promise<T>, opts?: { lockWaitMs?: number }): Promise<T> {
  // proper-lockfile lstats the target before locking; on the cold path it does not exist yet → ensure the directory first (idempotent)
  await fs.mkdir(target, { recursive: true });
  let release: () => Promise<void>;
  try {
    // The wait budget comes from the retry cadence (npm retry): default 5 exponential retries ≈ 6.2s fail-fast;
    // with lockWaitMs set, retry at 1s intervals for up to that long (e.g. the deepen path queuing behind a
    // matrix sibling's in-flight deepen).
    const retries = opts?.lockWaitMs
      ? { retries: Math.ceil(opts.lockWaitMs / 1000), factor: 1, minTimeout: 1000, maxTimeout: 1000 }
      : { retries: 5, minTimeout: 200 };
    release = await lockfile.lock(target, { stale: 30_000, retries });
  } catch (e) {
    if ((e as { code?: string }).code === 'ELOCKED') throw new LockTimeoutError('another fetch in progress');
    throw e;
  }
  try {
    return await fn();
  } finally {
    await release().catch(() => {});
  }
}

/** Checkout/update critical section: lock first, then check. The lock is taken before the directory
 *  existence check and both cold/hot paths share it — with 3 replicas sharing the .data volume,
 *  the old cold path `.catch(() => null)` swallowed ELOCKED and cloned bare, with rm happening
 *  before the lock (deleting the directory another replica was fetching): two replicas cold-cloning
 *  the same version simultaneously trampled each other.
 *  Re-check .git inside the lock: while waiting, the winner may have built the repo already — go
 *  straight down the hot fetchAndReset path.
 *  Retry 5×200ms (exponential backoff): a brief wait usually beats an immediate LockTimeoutError
 *  (the caller has its own upper-level retry). */
async function withCheckoutLock(target: string, info: ProjectRepo, branch: string, bounds: ShallowBounds = {}): Promise<string> {
  return withRepoLock(target, async () => {
    if (await dirExists(target) && await dirExists(path.join(target, '.git'))) {
      return await fetchAndReset(target, info, branch, bounds);
    }
    await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(target, { recursive: true });
    await cloneFirst(target, info, bounds);
    return await fetchAndReset(target, info, branch, bounds);
  });
}

/** Phase 1: no_repo / lock / directory skeleton first. clone / fetch / stash filled in later. */
export async function checkoutRepo(requirementId: string): Promise<string> {
  const info = await loadProjectRepo(requirementId);
  if (!info) throw new RepoUnavailableError('no_repo', 'project has no repoUrl configured');

  await fs.mkdir(REPOS_ROOT, { recursive: true });
  const target = path.join(REPOS_ROOT, requirementId);
  return withCheckoutLock(target, info, info.branch);
}

async function loadVersionRepo(versionId: string): Promise<ProjectRepo | null> {
  const row = (await db
    .select({
      repoUrl: projects.repoUrl,
      branch: projects.defaultBranch,
      provider: projects.provider,
      pat: projects.patOverride,
      gitlabOverride: projects.gitlabUrlOverride,
      versionRef: projectVersions.ref,
    })
    .from(projectVersions)
    .innerJoin(projects, eq(projectVersions.projectId, projects.id))
    .where(eq(projectVersions.id, versionId))
    .limit(1))[0];
  if (!row || !row.repoUrl) return null;
  return { repoUrl: row.repoUrl, branch: row.versionRef ?? row.branch, provider: row.provider, pat: row.pat, gitlabOverride: row.gitlabOverride };
}

/** Version-level checkout: sandbox directory v-<versionId>, isolated from requirement level; ref comes
 *  from version.ref, falling back to the project default branch. Tags work too (fetch FETCH_HEAD).
 *  targetDir can specify the checkout directory; when omitted .data/repos/v-<versionId> is used. */
export async function checkoutRepoForVersion(versionId: string, targetDir?: string, bounds: ShallowBounds = {}): Promise<string> {
  const info = await loadVersionRepo(versionId);
  if (!info) throw new RepoUnavailableError('no_repo', 'project has no repoUrl configured');

  const target = targetDir ?? path.join(REPOS_ROOT, `v-${versionId}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  return withCheckoutLock(target, info, info.branch, bounds);
}

/** Version worktree directory: .data/workspaces/v-<versionId>/repo.
 *  Assistant sessions and exploration scope resolution share this directory → they share the same
 *  checkout lock (`<dir>.lock`) and never stomp each other. */
export function versionWorkspaceDir(versionId: string): string {
  return path.join(WORKSPACES_ROOT, `v-${versionId}`, 'repo');
}

/** "Deepens" the version worktree's shallow clone enough to cover the target range (used by
 *  exploratory testing's code commit scope).
 *  The assistant side always fetches --depth 1 → the shallow clone has no history, so deepening
 *  must happen under the same lock, otherwise the two actions erase each other's deepened history.
 *  Cold path (worktree has no .git yet): check out directly to the target bounds.
 *  Returns the HEAD sha. */
export async function deepenVersionRepo(versionId: string, bounds: ShallowBounds): Promise<string> {
  const info = await loadVersionRepo(versionId);
  if (!info) throw new RepoUnavailableError('no_repo', 'project has no repoUrl configured');

  const target = versionWorkspaceDir(versionId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  return withRepoLock(target, async () => {
    const hasRepo = await dirExists(path.join(target, '.git'));
    if (!hasRepo) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => {});
      await fs.mkdir(target, { recursive: true });
      await cloneFirst(target, info, bounds);
    }
    await fetchAndReset(target, info, info.branch, bounds);
    return (await runGitIn(target, ['rev-parse', 'HEAD'])).trim();
  }, { lockWaitMs: DEEPEN_LOCK_WAIT_MS });
}
