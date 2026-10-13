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

  it('rg 不存在时 (PATH 强制覆盖) 返回明确错误', async () => {
    const tools = buildRepoSandboxTools(cwd);
    const t = tools.find((x) => x.name === 'repo_grep')!;
    // rg 可执行文件不在 PATH 中 → spawn 触发 ENOENT，经 runRg 抛出，被 execute 捕获为 ok:false。
    const prev = process.env.PATH;
    process.env.PATH = '/nonexistent-dir';
    try {
      const r = await t.execute({ pattern: 'hi' });
      expect(r.ok).toBe(false);
      expect((r as { error: string }).error).toContain('ENOENT');
    } finally { process.env.PATH = prev; }
  });
});

describe('countRepoGrepBatch', () => {
  let batchCwd: string;
  beforeAll(async () => {
    batchCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-rg-batch-'));
    await fs.writeFile(path.join(batchCwd, 'a.html'), '<i class="icon-chakan" title="查看"></i>\n<p>普通文案</p>');
    await fs.writeFile(path.join(batchCwd, 'b.html'), '<a title="查看">查看</a>\n<button title="查看">x</button>');
    await fs.writeFile(path.join(batchCwd, 'c.vue'), '<el-input :placeholder="keywordPlaceholder" />');
  });
  afterAll(async () => { await fs.rm(batchCwd, { recursive: true, force: true }); });

  it('N 个 pattern 单次遍历后按 pattern 归因（批量版的存在理由）', async () => {
    const { countRepoGrepBatch } = await import('../src/pi/repo.js');
    const table = await countRepoGrepBatch(batchCwd, [
      'title\\s*[:=]\\s*[\'"]{1,2}查看', // a + b 共 3 处
      'icon-chakan', // 1 处
      'placeholder', // 1 处
      'nonexistent_zzz', // 0 处
    ]);
    expect(table.get('title\\s*[:=]\\s*[\'"]{1,2}查看')!.count).toBe(3);
    expect(table.get('icon-chakan')!.count).toBe(1);
    expect(table.get('placeholder')!.count).toBe(1);
    expect(table.get('nonexistent_zzz')!.count).toBe(0);
  });

  it('与逐条版 countRepoGrep 计数一致（批量归因没跑偏）', async () => {
    const { countRepoGrep, countRepoGrepBatch } = await import('../src/pi/repo.js');
    const patterns = ['icon-chakan', 'placeholder', '查看', '普通文案'];
    const batch = await countRepoGrepBatch(batchCwd, patterns);
    for (const p of patterns) {
      const serial = await countRepoGrep(batchCwd, p);
      expect(batch.get(p)!.count, p).toBe(serial.count);
    }
  });

  it('大小写变体行也计入：归因正则须复刻 rg -S 的 smart-case（否则全小写 pattern 系统性少算）', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-rg-case-'));
    await fs.writeFile(
      path.join(dir, 'a.html'),
      ['placeholder="a"', 'PLACEHOLDER="b"', 'Placeholder="c"', 'unrelated=""'].join('\n'),
    );
    try {
      const { countRepoGrep, countRepoGrepBatch } = await import('../src/pi/repo.js');
      const batch = await countRepoGrepBatch(dir, ['placeholder']);
      const serial = await countRepoGrep(dir, 'placeholder');
      expect(batch.get('placeholder')!.count).toBe(3);
      expect(batch.get('placeholder')!.count).toBe(serial.count);
      // 含大写的 pattern 走区分大小写：rg 与 JS 侧同口径
      const upperBatch = await countRepoGrepBatch(dir, ['PLACEHOLDER']);
      expect(upperBatch.get('PLACEHOLDER')!.count).toBe(await countRepoGrep(dir, 'PLACEHOLDER').then((r) => r.count));
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('空 pattern 列表 → 空 Map，不 spawn', async () => {
    const { countRepoGrepBatch } = await import('../src/pi/repo.js');
    expect((await countRepoGrepBatch(batchCwd, [])).size).toBe(0);
  });

  it('rg 不存在时静默降级（全体 count=0），不抛错打断 verify_case', async () => {
    const { countRepoGrepBatch } = await import('../src/pi/repo.js');
    const prev = process.env.PATH;
    process.env.PATH = '/nonexistent-dir';
    try {
      const table = await countRepoGrepBatch(batchCwd, ['icon-chakan']);
      expect(table.get('icon-chakan')!.count).toBe(0);
    } finally { process.env.PATH = prev; }
  });

  it('pattern 数超上限时分批查询，计数跨批累计', async () => {
    const { countRepoGrepBatch, BATCH_GREP_MAX_PATTERNS } = await import('../src/pi/repo.js');
    const many = Array.from({ length: BATCH_GREP_MAX_PATTERNS + 5 }, (_, i) =>
      i === BATCH_GREP_MAX_PATTERNS + 4 ? 'icon-chakan' : `miss_${i}`);
    const table = await countRepoGrepBatch(batchCwd, many);
    expect(table.get('icon-chakan')!.count).toBe(1); // 落在第二批
    expect(table.get('miss_0')!.count).toBe(0);
    expect(table.size).toBe(many.length);
  });
});

describe('static_locator 工具', () => {
  it('一次批量查询给出全部候选的 verdict', async () => {
    const { buildRepoSandboxTools } = await import('../src/pi/repo.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-static-loc-'));
    await fs.writeFile(path.join(dir, 'a.html'), '<i class="icon-chakan" title="查看"></i>');
    await fs.writeFile(path.join(dir, 'b.html'), '<a title="查看">查看</a>\n<b title="查看">y</b>');
    try {
      const t = buildRepoSandboxTools(dir).find((x) => x.name === 'static_locator')!;
      const r = await t.execute({
        locators: [
          { strategy: 'css', value: '.icon-chakan' },
          { strategy: 'css', value: '[title="查看"]' },
        ],
      });
      expect(r.ok).toBe(true);
      const reports = JSON.parse((r as { data: string }).data) as Array<{ value: string; verdict: string }>;
      expect(reports.find((x) => x.value === '.icon-chakan')!.verdict).toBe('unique');
      expect(reports.find((x) => x.value === '[title="查看"]')!.verdict).toBe('multiple');
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});

describe('repo_run', () => {
  it('白名单 ls 返回 cwd 根目录列表', async () => {
    const tools = buildRepoSandboxTools(cwd);
    const t = tools.find((x) => x.name === 'repo_run')!;
    const r = await t.execute({ command: 'ls' });
    expect(r.ok).toBe(true);
    expect((r as { data: string }).data).toContain('a.txt');
  });

  it('黑名单命令直接拒绝', async () => {
    const tools = buildRepoSandboxTools(cwd);
    const t = tools.find((x) => x.name === 'repo_run')!;
    const cases = ['rm -rf /', 'curl http://evil', 'git push origin main', 'echo hi; rm -rf /', 'cat a.txt && rm a.txt'];
    for (const command of cases) {
      const r = await t.execute({ command });
      expect(r.ok, command).toBe(false);
    }
  });

  it('git 子命令二次白名单', async () => {
    const tools = buildRepoSandboxTools(cwd);
    const t = tools.find((x) => x.name === 'repo_run')!;
    // 'git init' 不在二次白名单
    const r = await t.execute({ command: 'git init' });
    expect(r.ok).toBe(false);
  });

  it('chain operators 拒绝（&& / ; / |）', async () => {
    const tools = buildRepoSandboxTools(cwd);
    const t = tools.find((x) => x.name === 'repo_run')!;
    const r = await t.execute({ command: 'ls | cat' });
    expect(r.ok).toBe(false);
  });
});