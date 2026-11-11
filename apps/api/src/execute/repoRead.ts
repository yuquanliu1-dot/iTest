/**
 * 仓库读码通道实现（探索会话的 repo 动作）：只读 + 沙箱限版本工作树的 repo/ 内。
 * read/grep/ls/diff 四 op；路径越界（assertInCwd 抛 SandboxViolationError）、文件不存在、
 * 配额耗尽都转成 ok:false 的错误反馈——错误文本是给模型看的，措辞必须可行动。
 * 与 pi 侧 buildRepoSandboxTools 的 repo_* 工具刻意不共用实现：那边是助手工具协议
 * （{ok,data} 字符串载荷），这边是 aiTask 的 RepoReadResult，封顶口径也不同。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { assertInCwd, gitRead, REPO_RUN_TIMEOUT_MS } from '../pi/repo.js';
import { REPO_OUTPUT_MAX_CHARS, type RepoReadRequest, type RepoReadResult } from './aiTask.js';

/** ls 单次列出的条目上限（模型反馈不需要全量目录树，截断带说明）。 */
const LS_MAX_ENTRIES = 200;

export interface RepoReadChannelOptions {
  /** 仓库工作树根（versionWorkspaceDir(versionId)）。 */
  repoDir: string;
  /** 提交范围基线 → 头（diff op 用）。未解析出范围时 diff 恒拒（通道根本不会被创建）。 */
  fromSha?: string | null;
  toSha?: string | null;
  /** 会话级调用配额（防模型把预算烧在读码上，照 sql 取证的配额形态）。 */
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

/** assertInCwd 通过后的绝对路径 → 给 rg/git 用的相对路径（输出干净、不泄机器绝对路径）。
 *  repoRoot 必须传 realpath 过的根：assertInCwd 内部按 realpath 比较，混用符号链接路径
 *  （macOS /tmp → /private/tmp）会让 path.relative 吐出 ../private/... 的废路径。 */
async function toRelative(repoRoot: string, target?: string): Promise<string> {
  if (!target || !target.trim()) return '.';
  const real = await assertInCwd(repoRoot, target);
  const rel = path.relative(repoRoot, real);
  return rel === '' ? '.' : rel;
}

const capContent = (s: string): string =>
  s.length > REPO_OUTPUT_MAX_CHARS ? `${s.slice(0, REPO_OUTPUT_MAX_CHARS)}\n…（已截断，用 path 参数缩小范围）` : s;

/**
 * 创建会话级读码通道：闭包持有配额计数，实例 = 一个探索会话的 runRepoRead。
 */
export function createRepoReadChannel(opts: RepoReadChannelOptions): (req: RepoReadRequest) => Promise<RepoReadResult> {
  let calls = 0;
  return async (req: RepoReadRequest): Promise<RepoReadResult> => {
    if (calls >= opts.maxCalls) {
      return { ok: false, error: `本会话仓库读码次数已用尽（上限 ${opts.maxCalls} 次）——优先用 diff/grep 定位，findings 以页面表现为准` };
    }
    calls += 1;
    try {
      // 根也过一次 assertInCwd（等价于取 realpath）：后续 join/relative 全用真根，
      // 避免符号链接路径（macOS /tmp）与 realpath 比较错位。
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
          // 先 stat 再过沙箱：realpath 对不存在的路径会失败并被误判成「越界」；
          // stat 在先才能给出「文件不存在」的正确反馈（越界路径 stat  succeeds 后仍会被沙箱拦住）。
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
          // rg 位置参数顺序：PATTERN 在前、PATH 在后（-- 之后第一个位置参数是 pattern）。
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
      // 沙箱越界给出可行动的反馈；其它异常照原样（spawn 失败/权限等）
      return { ok: false, error: msg.includes('path escapes cwd') ? `路径越界：${req.op === 'read' ? req.path : (req.path ?? '.')}（只能在仓库工作树内）` : msg.slice(0, 200) };
    }
  };
}
