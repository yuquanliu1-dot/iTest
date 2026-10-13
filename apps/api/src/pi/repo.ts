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

const DATA_DIR = process.env.PI_DATA_DIR ?? path.resolve(process.cwd(), '.data');
export const REPOS_ROOT = path.join(DATA_DIR, 'repos');
export const WORKSPACES_ROOT = path.join(DATA_DIR, 'workspaces');
export const REPO_LOCK_TIMEOUT_MS = 5_000;
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

/** 把任意结果安全序列化为 data 字符串（截断到 MAX_OUTPUT_CHARS）。 */
function asData(payload: unknown): string {
  const s = JSON.stringify(payload);
  return s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + '…(truncated)' : s;
}

/** 解析 user-supplied 路径为绝对路径，realpath 后必须 startsWith cwdRoot。
 *  越界一律抛 SandboxViolationError；调用方负责 try/catch 并返回 { ok: false, error }。 */
export async function assertInCwd(cwdRoot: string, target: string): Promise<string> {
  if (!target || typeof target !== 'string') {
    throw new SandboxViolationError('path is empty');
  }
  const abs = path.isAbsolute(target) ? target : path.join(cwdRoot, target);
  const real = await fs.realpath(abs).catch(() => abs);
  const rootReal = await fs.realpath(cwdRoot);
  // 在尾部加 separator 防止 /foo/barbaz 误判为 /foo/bar 的子串
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
      // code=1 表示无匹配（rg 约定），仍算成功
      if (code === 0 || code === 1) resolve({ stdout: out, code });
      reject(new Error(`rg exited ${code}: ${err}`));
    });
  });
}

/** cwdRoot 传静态目录(requirement 级)或 () => string(动态解析,空间级后台异步检出:
 *  未就绪/不可用时 throw,由各工具既有 try/catch 转为错误结果)。 */

/** 单 pattern 计数：L1 静态定位的逐条查询路径（批量版见 countRepoGrepBatch）。
 *  -c 按文件输出 path:count，输出量受「命中文件数」而非「命中行数」约束；
 *  --max-count=100 封顶单文件内计数（终极泛化锚点也不会炸输出）。rg 默认尊重 .gitignore。
 *  保留给需要单独 glob 或单条精确计数的调用方。 */
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

/** 批量模式的单文件行数上限。注意 rg 的 --max-count 是「每文件」而非「每 pattern」，
 *  N 个 pattern 共享这个配额（实测：300 文件 × 2 pattern，cap=2 → 恰好 600 行）。 */
const BATCH_MAX_COUNT_PER_FILE = 200;
/** 批量模式总输出行数上限，防止 common-word pattern（service/test/data）灌爆内存。
 *  超限即截断并置全体 truncated——计数只用于「唯一 / 多重 / 零命中」三分，
 *  截断只会让 count 偏大（multiple 方向），不会把 multiple 误判成 unique。 */
const BATCH_MAX_TOTAL_LINES = 20_000;
/** 批量模式每 pattern 记录的最大样例路径数（与 countRepoGrep 对齐）。 */
const BATCH_MAX_SAMPLE_PATHS = 10;
/** 单次 rg 的 pattern 数上限：一次 spawn 携带过多 -e 会顶到 ARG_MAX，且逐行归因的
 *  正则匹配开销线性增长。60 已远超真实用例的候选规模（12 步 × 2~4 候选 ≈ 30~80）。 */
export const BATCH_GREP_MAX_PATTERNS = 60;

/** 把 rg -n 的合并输出按 pattern 归因，写入 perPattern（就地累加）。
 *  rg 不标注命中来自哪个 -e，故取回整行原文后在内存里逐 pattern 跑已编译正则认领。 */
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
    // rg -n 输出 path:lineno:text。路径含冒号时用「首个 : 后跟数字」的形态定位分隔点。
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

/** 单次 rg 批量查 N 个 pattern：树只走一遍，JS 侧按 pattern 归因。
 *
 *  rg 合并输出不标注命中来自哪个 -e，而 analyzeLocatorCandidates 的判决（unique / multiple /
 *  not-found）依赖 per-pattern 计数，故用 -n 行模式取回整行原文后由 attributeLines 归因。
 *  N 个 pattern × 数千行 ≈ 数万次 regex.test，毫秒级，不是瓶颈。
 *
 *  实测（真实 40M 仓库 / 811 个 .ts）：34 次串行 spawn 1038ms → 单次批量 39ms。
 *  注意不要改成并发 spawn：rg 内部已按核数并行，外层再套并发只是在抢同一批 CPU（实测更慢）。 */
export async function countRepoGrepBatch(cwdRoot: string, patterns: string[]): Promise<Map<string, SourceCount>> {
  const out = new Map<string, SourceCount>();
  const uniq = [...new Set(patterns)].filter(Boolean);
  if (uniq.length === 0) return out;

  // 分批：每批一次 spawn。批数通常为 1（真实用例远达不到 60），超限时退化为多次遍历而非炸 ARG_MAX。
  for (let i = 0; i < uniq.length; i += BATCH_GREP_MAX_PATTERNS) {
    const chunk = uniq.slice(i, i + BATCH_GREP_MAX_PATTERNS);
    // 归因正则全部来自 extractGrepKeys 的 esc()（已转义 . * + ? ^ $ { } ( ) | [ ] \），
    // 必然可编译，不做逐 pattern 的 try/catch。
    const regexes = chunk.map((p) => ({ pattern: p, re: new RegExp(p) }));
    const perPattern = new Map<string, SourceCount>(
      chunk.map((p) => [p, { count: 0, truncated: false, samplePaths: [] }]),
    );
    const argList = ['--no-heading', '-n', '-S', `--max-count=${BATCH_MAX_COUNT_PER_FILE}`];
    for (const p of chunk) argList.push('-e', p);
    argList.push('--', '.');
    // rg 不可用/超时 → 本批全体记 0 命中（静态分析是 advisory，绝不因工具故障打断 verify_case；
    // 与逐条版对 rg 异常的宽松度一致）。perPattern 已预置 0 计数，故成败都要并进 out。
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
      description: '对一组候选 locator 做源码静态定位分析：逐候选查询该锚点字面量在仓库源码中的命中次数，返回 verdict（unique=源码唯一锚点 / multiple=源码命中多处→回放歧义风险 / not-found=源码未字面命中且无语义键（疑似臆造或改名）/ dynamic-suspect=源码未字面命中但存在动态绑定（如 :placeholder="变量"），运行时为准，勿据此判死 / skipped=无静态可判）。用于生成或修正 compiled 步骤的 locator 时：把伪唯一锚点（如 [title="查看"] 源码命中多处）换成语义唯一锚点（如 .icon-chakan）。',
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

function runGit(args: string[], cwdArg: string = process.cwd()): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: cwdArg, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => {
      const errNo = e as NodeJS.ErrnoException;
      // 容器镜像没装 git 时 spawn 即 ENOENT;原文「spawn git ENOENT」对运维没指导意义,
      // 转成可执行的修复建议,checkoutInBackground 会再透到 repo.issue。
      if (errNo.code === 'ENOENT' && errNo.message.includes('git')) {
        reject(new Error('git binary missing in runtime image; rebuild infra/docker/api.Dockerfile with git installed'));
      } else {
        reject(errNo);
      }
    });
    child.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(err.trim() || `git exit ${code}`)));
  });
}

function runGitIn(cwdArg: string, args: string[]): Promise<string> {
  return runGit(args, cwdArg);
}

async function cloneFirst(target: string, info: ProjectRepo): Promise<void> {
  try {
    await runGit(['clone', '--depth', '1', '--branch', info.branch, injectPat(info.repoUrl, info.provider, info.pat, info.gitlabOverride), target]);
  } catch (e) {
    await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    const msg = (e as Error).message;
    const reason: RepoUnavailableReason = /401|403|auth/i.test(msg) ? 'auth_failed' : 'clone_failed';
    throw new RepoUnavailableError(reason, msg);
  }
}

async function fetchAndReset(target: string, info: ProjectRepo, ref: string): Promise<string> {
  // 1. dirty 检查：tracked 修改 / untracked 文件 → stash
  const status = await runGitIn(target, ['status', '--porcelain']).catch(() => '');
  let stashRef: string | null = null;
  if (status.trim().length > 0) {
    const stashOut = await runGitIn(target, ['stash', 'push', '--include-untracked', '-m', `itest-auto-${Date.now()}`]);
    stashRef = stashOut.match(/refs\/stash\{\d+\}/)?.[0] ?? stashOut.trim();
  }
  // 2. fetch + reset（FETCH_HEAD 对 branch / tag 通用）
  try {
    await runGitIn(target, ['fetch', '--depth', '1', 'origin', ref]);
    await runGitIn(target, ['reset', '--hard', 'FETCH_HEAD']);
  } catch (e) {
    const msg = (e as Error).message;
    throw new RepoUnavailableError(/401|403/i.test(msg) ? 'auth_failed' : 'fetch_failed', msg);
  }
  // 3. 写 meta（branch 记录实际 ref）
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

/** 第一阶段：先实现 no_repo / 锁 / 目录骨架。clone / fetch / stash 后补。 */
export async function checkoutRepo(requirementId: string): Promise<string> {
  const info = await loadProjectRepo(requirementId);
  if (!info) throw new RepoUnavailableError('no_repo', 'project has no repoUrl configured');

  await fs.mkdir(REPOS_ROOT, { recursive: true });
  const target = path.join(REPOS_ROOT, requirementId);

  if (await dirExists(target) && await dirExists(path.join(target, '.git'))) {
    // 锁定；保证并发只跑一次 fetch
    try {
      const release = await lockfile.lock(target, { retries: 0, stale: 30_000 });
      try { return await fetchAndReset(target, info, info.branch); } finally { await release(); }
    } catch (e) {
      if ((e as { code?: string }).code === 'ELOCKED') throw new LockTimeoutError('another fetch in progress');
      throw e;
    }
  } else {
    await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(target, { recursive: true });
    const release = await lockfile.lock(target, { retries: 0, stale: 30_000 }).catch(() => null);
    try {
      await cloneFirst(target, info);
      return await fetchAndReset(target, info, info.branch);
    } finally { if (release) await release(); }
  }
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

/** 版本级 checkout：沙箱目录 v-<versionId> 与需求级隔离；ref 取 version.ref，缺省回落项目默认分支。tag 亦可用（fetch FETCH_HEAD）。
 *  可通过 targetDir 指定检出目录，未指定时沿用 .data/repos/v-<versionId>。 */
export async function checkoutRepoForVersion(versionId: string, targetDir?: string): Promise<string> {
  const info = await loadVersionRepo(versionId);
  if (!info) throw new RepoUnavailableError('no_repo', 'project has no repoUrl configured');

  const target = targetDir ?? path.join(REPOS_ROOT, `v-${versionId}`);
  await fs.mkdir(path.dirname(target), { recursive: true });

  if (await dirExists(target) && await dirExists(path.join(target, '.git'))) {
    // 锁定；保证并发只跑一次 fetch
    try {
      const release = await lockfile.lock(target, { retries: 0, stale: 30_000 });
      try { return await fetchAndReset(target, info, info.branch); } finally { await release(); }
    } catch (e) {
      if ((e as { code?: string }).code === 'ELOCKED') throw new LockTimeoutError('another fetch in progress');
      throw e;
    }
  } else {
    await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(target, { recursive: true });
    const release = await lockfile.lock(target, { retries: 0, stale: 30_000 }).catch(() => null);
    try {
      await cloneFirst(target, info);
      return await fetchAndReset(target, info, info.branch);
    } finally { if (release) await release(); }
  }
}
