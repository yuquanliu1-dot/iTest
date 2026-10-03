import fs from 'node:fs/promises';
import path from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import type { ToolExecutor } from './tools.js';

const DATA_DIR = process.env.PI_DATA_DIR ?? path.resolve(process.cwd(), '.data');
export const REPOS_ROOT = path.join(DATA_DIR, 'repos');
export const REPO_LOCK_TIMEOUT_MS = 5_000;
export const REPO_RUN_TIMEOUT_MS = 30_000;
export const MAX_OUTPUT_CHARS = 30_000;
export const MAX_REPO_ENTRIES = 500;
export const DEFAULT_READ_MAX_LINES = 200;
export const READ_MAX_LINES_HARD_CAP = 500;

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
                lines: sliced,
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
  ];
}
