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
    expect(r.error).toContain('path escapes cwd');
  });

  it('501 个非隐藏文件 → truncated:true 且 entries 长度 = 500', async () => {
    const bigdir = path.join(cwd, 'bigdir');
    await fs.mkdir(bigdir);
    try {
      await Promise.all(
        Array.from({ length: 501 }, (_, i) => i.toString()).map((i) =>
          fs.writeFile(path.join(bigdir, `f${i}`), ''),
        ),
      );
      const tools = buildRepoSandboxTools(cwd);
      const ls = tools.find((t) => t.name === 'repo_ls')!;
      const r = await ls.execute({ path: 'bigdir' });
      expect(r.ok).toBe(true);
      const data = JSON.parse((r as { data: string }).data);
      expect(data.truncated).toBe(true);
      expect(data.entries.length).toBe(500);
    } finally {
      await fs.rm(bigdir, { recursive: true, force: true });
    }
  });

  it('隐藏文件被过滤', async () => {
    await fs.writeFile(path.join(cwd, '.hidden'), 'secret');
    const tools = buildRepoSandboxTools(cwd);
    const ls = tools.find((t) => t.name === 'repo_ls')!;
    const r = await ls.execute({ path: '.' });
    expect(r.ok).toBe(true);
    const data = JSON.parse((r as { data: string }).data);
    const names = data.entries.map((e: { name: string }) => e.name);
    expect(names).not.toContain('.hidden');
  });
});

describe('repo_read', () => {
  it('读文本文件返回行号+内容', async () => {
    await fs.writeFile(path.join(cwd, 'lines.txt'), 'a\nb\nc\n');
    const tools = buildRepoSandboxTools(cwd);
    const t = tools.find((x) => x.name === 'repo_read')!;
    const r = await t.execute({ path: 'lines.txt' });
    expect(r.ok).toBe(true);
    const data = JSON.parse((r as { data: string }).data);
    expect(data.content).toBe('a\nb\nc\n');
    expect(data.totalLines).toBe(3);
  });

  it('offset / maxLines 切片', async () => {
    await fs.writeFile(path.join(cwd, 'big.txt'), Array.from({ length: 100 }, (_, i) => `L${i}`).join('\n'));
    const tools = buildRepoSandboxTools(cwd);
    const t = tools.find((x) => x.name === 'repo_read')!;
    const r = await t.execute({ path: 'big.txt', offset: 10, maxLines: 5 });
    const data = JSON.parse((r as { data: string }).data);
    expect(data.content).toBe('L10\nL11\nL12\nL13\nL14');
    expect(data.truncated).toBe(true);
  });

  it('maxLines > 500 强制截断到 500', async () => {
    await fs.writeFile(path.join(cwd, 'huge.txt'), 'x\n'.repeat(2000));
    const tools = buildRepoSandboxTools(cwd);
    const t = tools.find((x) => x.name === 'repo_read')!;
    const r = await t.execute({ path: 'huge.txt', maxLines: 9999 });
    expect(r.ok).toBe(true);
    const data = JSON.parse((r as { data: string }).data);
    expect(data.truncated).toBe(true);
    expect((data.content.match(/\n/g) ?? []).length).toBe(500);
  });

  it('二进制文件返回 ok:false', async () => {
    await fs.writeFile(path.join(cwd, 'blob.bin'), Buffer.from([0, 1, 2, 0, 5]));
    const tools = buildRepoSandboxTools(cwd);
    const t = tools.find((x) => x.name === 'repo_read')!;
    const r = await t.execute({ path: 'blob.bin' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('binary file');
  });

  it('路径穿越返回 ok:false', async () => {
    const tools = buildRepoSandboxTools(cwd);
    const t = tools.find((x) => x.name === 'repo_read')!;
    const r = await t.execute({ path: '../../etc/passwd' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('path escapes cwd');
  });
});

describe('repo_grep', () => {
  beforeAll(async () => {
    await fs.writeFile(path.join(cwd, 'a.ts'), 'export function hello() {\n  return "hi";\n}\n');
    await fs.writeFile(path.join(cwd, 'b.ts'), 'export const greeting = "hi";\n');
  });

  it('基本匹配返回 { matches: [{ path, line, text }] }', async () => {
    const tools = buildRepoSandboxTools(cwd);
    const t = tools.find((x) => x.name === 'repo_grep')!;
    const r = await t.execute({ pattern: 'greeting' });
    expect(r.ok).toBe(true);
    const data = JSON.parse((r as { data: string }).data);
    expect(data.matches.length).toBeGreaterThan(0);
    expect(data.matches.some((m: { path: string }) => m.path.endsWith('b.ts'))).toBe(true);
  });

  it('glob 过滤文件', async () => {
    const tools = buildRepoSandboxTools(cwd);
    const t = tools.find((x) => x.name === 'repo_grep')!;
    const r = await t.execute({ pattern: 'hi', glob: '*.ts' });
    const data = JSON.parse((r as { data: string }).data);
    expect(data.matches.length).toBeGreaterThan(0);
  });

  it('找不到匹配返回空数组', async () => {
    const tools = buildRepoSandboxTools(cwd);
    const t = tools.find((x) => x.name === 'repo_grep')!;
    const r = await t.execute({ pattern: '__nonexistent_xyz__' });
    expect(r.ok).toBe(true);
    const data = JSON.parse((r as { data: string }).data);
    expect(data.matches).toEqual([]);
  });

  it('rg 不存在时返回明确错误', async () => {
    const tools = buildRepoSandboxTools(cwd);
    const t = tools.find((x) => x.name === 'repo_grep')!;
    // force rg 找不到：通过 env PATH 强制覆盖
    const prev = process.env.PATH;
    process.env.PATH = '/nonexistent-dir';
    try {
      const r = await t.execute({ pattern: 'hi' });
      expect(r.ok).toBe(false);
      expect((r as { error: string }).error).toMatch(/rg|ripgrep|ENOENT/i);
    } finally { process.env.PATH = prev; }
  });
});