import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { Type } from '@earendil-works/pi-ai';
// @ts-expect-error proper-lockfile ships no .d.ts; lock/release signature is obvious
import lockfile from 'proper-lockfile';
import { db } from '../db/client.js';
import { projects, requirements } from '../db/schema.js';
import type { ToolExecutor } from './tools.js';

const DATA_DIR = process.env.PI_DATA_DIR ?? path.resolve(process.cwd(), '.data');
export const REPOS_ROOT = path.join(DATA_DIR, 'repos');
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

export function buildRepoSandboxTools(cwdRoot: string): ToolExecutor[] {
  return [
    {
      name: 'repo_ls',
      description: '列出 cwd 下某目录的文件与子目录（不含隐藏文件）。最多 500 项。',
      parameters: Type.Object({
        path: Type.Optional(Type.String()),
      }),
      execute: async (input) => {
        const { path: p } = input as { path?: string };
        try {
          const real = await assertInCwd(cwdRoot, p ?? '.');
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
      description: '读取 cwd 下文本文件的指定行范围（默认前 200 行，最多 500 行）。',
      parameters: Type.Object({
        path: Type.String({ minLength: 1 }),
        offset: Type.Optional(Type.Number({ minimum: 0 })),
        maxLines: Type.Optional(Type.Number({ minimum: 1 })),
      }),
      execute: async (input) => {
        const { path: p, offset = 0, maxLines = DEFAULT_READ_MAX_LINES } = input as { path: string; offset?: number; maxLines?: number };
        const cap = Math.min(maxLines, READ_MAX_LINES_HARD_CAP);
        try {
          const real = await assertInCwd(cwdRoot, p);
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
      description: '在 cwd 下用 ripgrep 搜索；输出形如 file:line:text。maxMatches 默认 200。',
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
          const { stdout } = await runRg(cwdRoot, args);
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
      name: 'repo_run',
      description: '在 cwd 下执行白名单单命令；用于 git log/show/diff/ls-files/grep/status 等二级需求。',
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
            const child = spawn(top, parts.slice(1), { cwd: cwdRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
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
    child.on('error', reject);
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

async function fetchAndReset(target: string, info: ProjectRepo): Promise<string> {
  // 1. dirty 检查：tracked 修改 / untracked 文件 → stash
  const status = await runGitIn(target, ['status', '--porcelain']).catch(() => '');
  let stashRef: string | null = null;
  if (status.trim().length > 0) {
    const stashOut = await runGitIn(target, ['stash', 'push', '--include-untracked', '-m', `itest-auto-${Date.now()}`]);
    stashRef = stashOut.match(/refs\/stash\{\d+\}/)?.[0] ?? stashOut.trim();
  }
  // 2. fetch + reset
  try {
    await runGitIn(target, ['fetch', '--depth', '1', 'origin', info.branch]);
    await runGitIn(target, ['reset', '--hard', `origin/${info.branch}`]);
  } catch (e) {
    const msg = (e as Error).message;
    throw new RepoUnavailableError(/401|403/i.test(msg) ? 'auth_failed' : 'fetch_failed', msg);
  }
  // 3. 写 meta
  const commit = (await runGitIn(target, ['rev-parse', 'HEAD'])).trim();
  await fs.writeFile(path.join(target, '.itest-sandbox.json'), JSON.stringify({
    provider: info.provider,
    branch: info.branch,
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

  if (await dirExists(target)) {
    // 锁定；保证并发只跑一次 fetch
    try {
      const release = await lockfile.lock(target, { retries: 0, stale: 30_000 });
      try { return await fetchAndReset(target, info); } finally { await release(); }
    } catch (e) {
      if ((e as { code?: string }).code === 'ELOCKED') throw new LockTimeoutError('another fetch in progress');
      throw e;
    }
  } else {
    await fs.mkdir(target, { recursive: true });
    const release = await lockfile.lock(target, { retries: 0, stale: 30_000 }).catch(() => null);
    try {
      await cloneFirst(target, info);
      return await fetchAndReset(target, info);
    } finally { if (release) await release(); }
  }
}
