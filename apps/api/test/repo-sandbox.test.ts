import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildRepoSandboxTools } from '../src/pi/repo.js';

let cwd: string;
beforeAll(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-repo-sandbox-'));
  await fs.writeFile(path.join(cwd, 'a.txt'), 'hello');
  await fs.mkdir(path.join(cwd, 'sub'));
  await fs.writeFile(path.join(cwd, 'sub', 'b.txt'), 'world');
});
afterAll(async () => { await fs.rm(cwd, { recursive: true, force: true }); });

describe('assertInCwd', () => {
  it('relative 路径解析后必须在 cwd 内', async () => {
    const { assertInCwd } = await import('../src/pi/repo.js');
    const r = await assertInCwd(cwd, 'a.txt');
    expect(r).toBe(await fs.realpath(path.join(cwd, 'a.txt')));
  });

  it('path traversal 抛 SandboxViolationError', async () => {
    const { assertInCwd, SandboxViolationError } = await import('../src/pi/repo.js');
    await expect(assertInCwd(cwd, '../../etc/passwd')).rejects.toBeInstanceOf(SandboxViolationError);
    await expect(assertInCwd(cwd, '/etc/passwd')).rejects.toBeInstanceOf(SandboxViolationError);
  });

  it('symlink 跳出 cwd 也抛 SandboxViolationError', async () => {
    const { assertInCwd, SandboxViolationError } = await import('../src/pi/repo.js');
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-repo-out-'));
    await fs.writeFile(path.join(outside, 'x'), 'x');
    await fs.symlink(outside, path.join(cwd, 'escape'));
    try {
      await expect(assertInCwd(cwd, 'escape/x')).rejects.toBeInstanceOf(SandboxViolationError);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe('repo_ls', () => {
  it('列出 cwd 根目录', async () => {
    const tools = buildRepoSandboxTools(cwd);
    const ls = tools.find((t) => t.name === 'repo_ls')!;
    const r = await ls.execute({ path: '.' });
    expect(r.ok).toBe(true);
    const data = JSON.parse((r as { data: string }).data);
    const names = data.entries.map((e: { name: string }) => e.name);
    expect(names).toContain('a.txt');
    expect(names).toContain('sub');
  });

  it('列子目录', async () => {
    const tools = buildRepoSandboxTools(cwd);
    const ls = tools.find((t) => t.name === 'repo_ls')!;
    const r = await ls.execute({ path: 'sub' });
    expect(r.ok).toBe(true);
    const data = JSON.parse((r as { data: string }).data);
    expect(data.entries[0].name).toBe('b.txt');
  });

  it('路径穿越返回 ok:false', async () => {
    const tools = buildRepoSandboxTools(cwd);
    const ls = tools.find((t) => t.name === 'repo_ls')!;
    const r = await ls.execute({ path: '../' });
    expect(r.ok).toBe(false);
  });
});