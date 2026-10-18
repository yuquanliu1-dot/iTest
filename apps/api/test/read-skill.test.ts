import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readSkillDir, readSkillFile, buildSkillsSectionContent } from '../src/pi/space/tools/readSkill.js';
import { listSkillTree, countSkillFiles } from '../src/pi/space/skillsStore.js';

let root: string;

beforeAll(async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-skills-'));
  root = path.join(ws, 'skills');
  await fs.mkdir(path.join(root, 'echo', 'scripts'), { recursive: true });
  await fs.mkdir(path.join(root, 'echo', 'agents'), { recursive: true });
  await fs.mkdir(path.join(root, 'echo', '.git'), { recursive: true });
  await fs.writeFile(path.join(root, 'echo', 'SKILL.md'), '---\nname: echo\ndescription: 回显\n---\n正文EchoBody');
  await fs.writeFile(path.join(root, 'echo', 'scripts', 'a.js'), 'console.log(1)');
  await fs.writeFile(path.join(root, 'echo', 'scripts', 'b.py'), '#!/usr/bin/env python3\nprint(2)');
  await fs.writeFile(path.join(root, 'echo', 'agents', 'grader.md'), 'grader 正文');
  await fs.writeFile(path.join(root, 'echo', '.git', 'config'), 'z');
});

afterAll(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true });
});

describe('read_skill（全局 skills 库）', () => {
  it('读 SKILL.md 正文（剥 frontmatter）+ 递归文件树', () => {
    const hit = readSkillDir(root, 'echo');
    expect(hit?.body).toBe('正文EchoBody'); // 前置 YAML 前言被剥掉，只回正文本体
    expect(hit?.body).not.toContain('name:'); // 不漏前言噪音（catalog 已有 name/description）
    const paths = hit?.files.map((f) => f.path) ?? [];
    expect(paths).toContain('scripts');
    expect(paths).toContain('scripts/a.js');
    expect(paths).toContain('scripts/b.py');
    expect(paths).toContain('agents');
    expect(paths).toContain('agents/grader.md');
    expect(paths.some((p) => p.includes('.git'))).toBe(false);
    // runtime 按扩展名标注（.py→python3 / .js→node），非可执行文件不给
    expect(hit?.files.find((f) => f.path === 'scripts/b.py')?.runtime).toBe('python3');
    expect(hit?.files.find((f) => f.path === 'scripts/a.js')?.runtime).toBe('node');
    expect(hit?.files.find((f) => f.path === 'agents/grader.md')?.runtime).toBeUndefined();
  });

  it('路径逃逸双守卫：../ 与绝对路径都拒绝', () => {
    expect(readSkillDir(root, '..')).toBeNull();
    expect(readSkillDir(root, '/etc')).toBeNull();
    expect(readSkillDir(root, '../echo')).toBeNull();
    expect(readSkillDir(root, 'echo/../../etc')).toBeNull();
    expect(readSkillDir(root, '')).toBeNull(); // 空名也拒绝（resolve 到 root 本身）
    expect(readSkillDir(root, '.git')).toBeNull(); // 隐藏段逐段拒
  });

  it('readSkillFile：读单文件 + 越界/软链拒绝', () => {
    expect(readSkillFile(root, 'echo', 'agents/grader.md')).toBe('grader 正文');
    expect(readSkillFile(root, 'echo', '../../etc/passwd')).toBeNull();
    expect(readSkillFile(root, 'echo', '/etc/passwd')).toBeNull();
    expect(readSkillFile(root, 'echo', 'scripts')).toBeNull(); // 目录不是文件
    expect(readSkillFile(root, 'echo', 'no-such.md')).toBeNull();
  });

  it('buildSkillsSectionContent：available_skills XML 只含 catalog（无正文）+ 读文件用法', () => {
    const s = buildSkillsSectionContent([{ name: 'echo', description: '回显', location: '/abs/echo/SKILL.md' }]);
    expect(s).toContain('<available_skills>');
    expect(s).toContain('name="echo"');
    expect(s).toContain('read_skill');
    expect(s).toContain('file=');
    expect(s).toContain('run_skill_script');
    expect(s).not.toContain('正文EchoBody'); // catalog-only，正文靠 read_skill 取
  });

  it('buildSkillsSectionContent：name/description 中的 XML 特殊字符被转义（防提示词注入）', () => {
    const s = buildSkillsSectionContent([
      { name: 'a"b<c>&d', description: 'say "hi" & <bye>', location: '/x' },
    ]);
    expect(s).toContain('name="a&quot;b&lt;c&gt;&amp;d"');
    expect(s).toContain('description="say &quot;hi&quot; &amp; &lt;bye&gt;"');
    expect(s).not.toContain('a"b<c>'); // 原始尖括号/引号不得原样出现
  });
});

describe('listSkillTree / countSkillFiles', () => {
  it('递归列出整棵树，剔除 .git/node_modules/隐藏文件/软链', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-tree-'));
    await fs.mkdir(path.join(dir, 'scripts'), { recursive: true });
    await fs.mkdir(path.join(dir, 'references'), { recursive: true });
    await fs.mkdir(path.join(dir, '.git'), { recursive: true });
    await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), 'x');
    await fs.writeFile(path.join(dir, 'scripts', 'run.py'), 'print(1)');
    await fs.writeFile(path.join(dir, 'scripts', 'tool.sh'), 'echo hi');
    await fs.writeFile(path.join(dir, 'references', 'schemas.md'), 'y');
    await fs.writeFile(path.join(dir, 'references', 'tmpl.html'), '<p>');
    await fs.writeFile(path.join(dir, '.git', 'config'), 'z');
    await fs.writeFile(path.join(dir, 'node_modules', 'x.js'), 'x');
    await fs.symlink(path.join(dir, 'scripts'), path.join(dir, 'linked'));

    const tree = listSkillTree(dir);
    expect(tree.map((n) => n.path).sort()).toEqual([
      'SKILL.md', 'references', 'references/schemas.md', 'references/tmpl.html',
      'scripts', 'scripts/run.py', 'scripts/tool.sh',
    ]);
    expect(tree.find((n) => n.path === 'scripts/run.py')?.runtime).toBe('python3');
    expect(tree.find((n) => n.path === 'scripts/tool.sh')?.runtime).toBe('bash');
    expect(tree.find((n) => n.path === 'references/schemas.md')?.runtime).toBeUndefined(); // 非可执行扩展名不给 runtime

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('超 200 文件截断，不无限膨胀', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-big-'));
    await fs.mkdir(path.join(dir, 'scripts'), { recursive: true });
    for (let i = 0; i < 260; i++) await fs.writeFile(path.join(dir, 'scripts', `f${i}.py`), 'x');
    expect(listSkillTree(dir).length).toBeLessThanOrEqual(200);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('countSkillFiles 只数数量与字节，不读内容', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-count-'));
    await fs.mkdir(path.join(dir, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), 'x');
    await fs.writeFile(path.join(dir, 'scripts', 'a.py'), 'y'.repeat(10_000));
    expect(countSkillFiles(dir)).toEqual({ fileCount: 2, totalBytes: 10_001 });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('目录不存在 → 空树/零统计，不抛错', () => {
    const missing = path.join(os.tmpdir(), 'itest-does-not-exist-xyz');
    expect(listSkillTree(missing)).toEqual([]);
    expect(countSkillFiles(missing)).toEqual({ fileCount: 0, totalBytes: 0 });
  });
});
