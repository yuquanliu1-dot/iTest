/**
 * Repo code-reading channel implementation (the exploratory session's repo actions): read-only + sandboxed to the version workspace's repo/ tree.
 * Four ops: read/grep/ls/diff; path escapes (assertInCwd throws SandboxViolationError), missing files,
 * and exhausted quotas all become ok:false error feedback — the error text is read by the model, so the wording must be actionable.
 * Deliberately not shared with the pi side's buildRepoSandboxTools repo_* tools: that side is the assistant tool protocol
 * ({ok,data} string payloads); this side is aiTask's RepoReadResult, with a different capping scheme.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { assertInCwd, gitRead, REPO_RUN_TIMEOUT_MS } from '../pi/repo.js';
import { REPO_OUTPUT_MAX_CHARS, type RepoReadRequest, type RepoReadResult } from './aiTask.js';

/** ls per-call entry cap (model feedback doesn't need the full directory tree; truncate with a note). */
const LS_MAX_ENTRIES = 200;

export interface RepoReadChannelOptions {
  /** Repo worktree root (versionWorkspaceDir(versionId)). */
  repoDir: string;
  /** Commit-range baseline → head (for the diff op). When no range resolves, diff always refuses (the channel isn't even created). */
  fromSha?: string | null;
  toSha?: string | null;
  /** Session-level call quota (stops the model burning budget on code reading; mirrors the sql evidence channel's quota shape). */
  maxCalls: number;
}

function spawnRg(cwd: string, args: string[]): Promise<{ stdout: string; code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('rg', args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`rg timeout after ${REPO_RUN_TIMEOUT_MS}ms`)); }, REPO_RUN_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout: out, code: code ?? -1, stderr: err }); });
  });
}

/** Absolute path (after assertInCwd passes) → relative path for rg/git (clean output; leaks no machine-absolute paths).
 *  repoRoot must be the realpath-ed root: assertInCwd compares by realpath internally, and mixing symlinked paths
 *  (macOS /tmp → /private/tmp) makes path.relative produce garbage like ../private/.... */
async function toRelative(repoRoot: string, target?: string): Promise<string> {
  if (!target || !target.trim()) return '.';
  const real = await assertInCwd(repoRoot, target);
  const rel = path.relative(repoRoot, real);
  return rel === '' ? '.' : rel;
}

const capContent = (s: string): string =>
  s.length > REPO_OUTPUT_MAX_CHARS ? `${s.slice(0, REPO_OUTPUT_MAX_CHARS)}\n…（已截断，用 path 参数缩小范围）` : s;

/**
 * Creates the session-level code-reading channel: the closure holds the quota counter; one instance = one exploratory session's runRepoRead.
 */
export function createRepoReadChannel(opts: RepoReadChannelOptions): (req: RepoReadRequest) => Promise<RepoReadResult> {
  let calls = 0;
  return async (req: RepoReadRequest): Promise<RepoReadResult> => {
    if (calls >= opts.maxCalls) {
      return { ok: false, error: `本会话仓库读码次数已用尽（上限 ${opts.maxCalls} 次）——优先用 diff/grep 定位，findings 以页面表现为准` };
    }
    calls += 1;
    try {
      // The root also goes through assertInCwd once (equivalent to taking the realpath): all later join/relative calls use the true root,
      // avoiding a symlinked path (macOS /tmp) mismatching the realpath comparison.
      const repoRoot = await assertInCwd(opts.repoDir, '.');
      switch (req.op) {
        case 'ls': {
          const joined = path.join(repoRoot, req.path ?? '.');
          const stat = await fs.stat(joined).catch(() => null);
          if (!stat) return { ok: false, error: `目录不存在：${req.path ?? '.'}（先 ls 仓库根看顶层结构）` };
          if (!stat.isDirectory()) return { ok: false, error: `不是目录：${req.path}（文件请用 read）` };
          const real = await assertInCwd(repoRoot, req.path ?? '.');
          const entries = await fs.readdir(real, { withFileTypes: true });
          const visible = entries.filter((e) => !e.name.startsWith('.'));
          const lines = visible.slice(0, LS_MAX_ENTRIES).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
          const note = visible.length > LS_MAX_ENTRIES ? `\n…（共 ${visible.length} 项，仅显示前 ${LS_MAX_ENTRIES} 项）` : '';
          return { ok: true, content: capContent(lines.join('\n') + note) || '（空目录）' };
        }
        case 'read': {
          // stat first, then the sandbox: realpath fails on nonexistent paths and would be misjudged as "out of bounds";
          // stat going first gives the correct "file missing" feedback (an out-of-bounds path that stat succeeds on is still blocked by the sandbox).
          const joined = path.join(repoRoot, req.path);
          const stat = await fs.stat(joined).catch(() => null);
          if (!stat) return { ok: false, error: `文件不存在：${req.path}（先 ls 上级目录或 grep 关键词定位）` };
          const real = await assertInCwd(repoRoot, req.path);
          if (!stat.isFile()) return { ok: false, error: `不是文件：${req.path}（目录请用 ls）` };
          const fh = await fs.open(real, 'r');
          try {
            const head = Buffer.alloc(Math.min(512, stat.size));
            await fh.read(head, 0, head.length, 0);
            if (head.includes(0)) return { ok: false, error: `二进制文件不可读：${req.path}` };
            const all = await fh.readFile('utf8');
            const hasTrailingNl = all.endsWith('\n');
            const lines = (hasTrailingNl ? all.slice(0, -1) : all).split('\n');
            const sliced = lines.slice(req.offset, req.offset + req.maxLines);
            const body = sliced.map((l, i) => `${req.offset + i + 1}| ${l}`).join('\n');
            const notes: string[] = [];
            if (req.offset > 0) notes.push(`从第 ${req.offset + 1} 行起`);
            if (lines.length > req.offset + req.maxLines) notes.push(`共 ${lines.length} 行，已截断（加大 offset 看后续）`);
            return { ok: true, content: capContent(body + (notes.length > 0 ? `\n（${notes.join('；')}）` : '')) || '（空文件）' };
          } finally {
            await fh.close();
          }
        }
        case 'grep': {
          const rel = await toRelative(repoRoot, req.path);
          // rg positional-arg order: PATTERN before PATH (the first positional after -- is the pattern).
          const args = ['--no-heading', '-n', '-S', `--max-count=${req.maxLines}`, '--', req.pattern, rel];
          const { stdout, code, stderr } = await spawnRg(repoRoot, args);
          if (code !== 0 && code !== 1) return { ok: false, error: `rg 失败（exit ${code}）：${stderr.trim().slice(0, 200)}` };
          if (!stdout.trim()) return { ok: true, content: '（无命中——换更宽的 pattern，或确认关键词确实存在于仓库）' };
          const lines = stdout.split('\n').filter(Boolean);
          const note = lines.length > req.maxLines ? `\n…（共 ${lines.length} 条命中，仅显示前 ${req.maxLines} 条）` : '';
          return { ok: true, content: capContent(lines.slice(0, req.maxLines).join('\n') + note) };
        }
        case 'diff': {
          if (!opts.fromSha || !opts.toSha) {
            return { ok: false, error: '本会话未解析出提交范围的基线，diff 不可用——用 read/grep 直接看文件' };
          }
          const rel = await toRelative(repoRoot, req.path);
          const args = ['diff', '--stat', `${opts.fromSha}..${opts.toSha}`];
          if (rel !== '.') args.push('--', rel);
          const statOut = await gitRead(repoRoot, args);
          const head = rel === '.'
            ? `范围改动统计（${opts.fromSha.slice(0, 8)}..${opts.toSha.slice(0, 8)}）：\n${statOut.trim()}`
            : `文件改动统计 ${rel}：\n${statOut.trim()}`;
          const detailArgs = ['diff', `${opts.fromSha}..${opts.toSha}`];
          if (rel !== '.') detailArgs.push('--', rel);
          const detail = await gitRead(repoRoot, detailArgs);
          return { ok: true, content: capContent(`${head}\n\n${detail}`) };
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Sandbox escapes get actionable feedback; other exceptions pass through as-is (spawn failure/permissions etc.)
      return { ok: false, error: msg.includes('path escapes cwd') ? `路径越界：${req.op === 'read' ? req.path : (req.path ?? '.')}（只能在仓库工作树内）` : msg.slice(0, 200) };
    }
  };
}
