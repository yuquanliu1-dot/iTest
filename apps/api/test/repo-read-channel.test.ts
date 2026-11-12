import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRepoReadChannel } from '../src/execute/repoRead.js';

let root: string;
let outsideFile: string;
let shaA: string;
let shaB: string;

beforeAll(async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-repo-read-'));
  root = path.join(parent, 'repo');
  await fs.mkdir(root);
  // A real file outside the sandbox: reading it must be rejected (existence does not substitute for the out-of-bounds check)
  outsideFile = path.join(parent, 'outside.txt');
  await fs.writeFile(outsideFile, 'secret');
  const git = (cmd: string) => execSync(cmd, { cwd: root, stdio: 'pipe' });
  git('git init -b main .');
  git('git config user.email t@t');
  git('git config user.name t');
  await fs.writeFile(path.join(root, 'app.ts'), 'const a = 1;\nexport default a;\n');
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'routes.ts'), "path:'/asset/list'\npath:'/login'\n");
  git('git add -A');
  git('git commit -q -m c1');
  shaA = git('git rev-parse HEAD').toString().trim();
  await fs.writeFile(path.join(root, 'app.ts'), 'const a = 2;\nexport default a;\n');
  git('git add -A');
  git('git commit -q -m c2');
  shaB = git('git rev-parse HEAD').toString().trim();
});

afterAll(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true });
});

const channel = (over: Partial<Parameters<typeof createRepoReadChannel>[0]> = {}) =>
  createRepoReadChannel({ repoDir: root, fromSha: shaA, toSha: shaB, maxCalls: 10, ...over });

describe('createRepoReadChannel', () => {
  it('ls：列目录、隐藏文件过滤、目录带 /', async () => {
    const r = await channel()({ op: 'ls' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content.split('\n')).toEqual(['app.ts', 'src/']);
  });

  it('read：带行号、offset/maxLines 生效', async () => {
    const ch = channel();
    const r1 = await ch({ op: 'read', path: 'src/routes.ts', offset: 0, maxLines: 1 });
    expect(r1.ok && r1.content).toBe('1| path:\'/asset/list\'\n（共 2 行，已截断（加大 offset 看后续））');
    const r2 = await ch({ op: 'read', path: 'src/routes.ts', offset: 1, maxLines: 5 });
    expect(r2.ok && r2.content).toBe("2| path:'/login'\n（从第 2 行起）");
  });

  it('read：不存在的文件给可行动错误', async () => {
    const r = await channel()({ op: 'read', path: 'nope/nope.ts', offset: 0, maxLines: 10 });
    expect(!r.ok && r.error).toContain('文件不存在');
  });

  it('grep：pattern 在 path 参数之前（rg 位置参数顺序）', async () => {
    const r = await channel()({ op: 'grep', pattern: '/asset/list', maxLines: 10 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toContain('src/routes.ts:1');
  });

  it('grep：限子目录', async () => {
    const r = await channel()({ op: 'grep', pattern: 'const a', path: 'src', maxLines: 10 });
    expect(r.ok && r.content).toBe('（无命中——换更宽的 pattern，或确认关键词确实存在于仓库）');
  });

  it('read：越界路径拒收（沙箱）', async () => {
    const r = await channel()({ op: 'read', path: '../outside.txt', offset: 0, maxLines: 10 });
    expect(!r.ok && r.error).toContain('越界');
  });

  it('diff：基线..头 的改动统计与内容', async () => {
    const r = await channel()({ op: 'diff' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.content).toContain('app.ts');
      expect(r.content).toContain('const a = 2;');
    }
  });

  it('diff：未解析出范围时明确拒绝', async () => {
    const r = await channel({ fromSha: null, toSha: null })({ op: 'diff' });
    expect(!r.ok && r.error).toContain('diff 不可用');
  });

  it('配额耗尽后恒拒', async () => {
    const ch = channel({ maxCalls: 2 });
    await ch({ op: 'ls' });
    await ch({ op: 'ls' });
    const r = await ch({ op: 'ls' });
    expect(!r.ok && r.error).toContain('次数已用尽');
  });
});
