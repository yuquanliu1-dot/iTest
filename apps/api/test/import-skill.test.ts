/**
 * import_skill：URL 校验 + 解析（真跑 git clone 的网络路径不做单测，用 pure 函数隔离）。
 *
 * 覆盖：
 *  - parseSkillUrl：合法 github 形态收；非 https / 非 github.com / userinfo / 端口 / 多余路径段拒绝；
 *    /tree/<ref> 解析；ref 注入（leading -、..）拒绝。
 *  - sanitizeSlug：大小写/非法字符/折叠/首尾 - 处理；结果空 → null。
 *  - parseSkillRepo（本地 tmp 目录，不碰网络）：frontmatter name/description、引号、坏名回退仓库名、
 *    无 frontmatter 回退 sanitize、scripts/ 目录与根脚本、shebang runtime、未知 runtime/文件名非法/超大 skip、
 *    SKILL.md 缺失抛错。
 *  - 工具侧：注册闸门（manager 才注册 import_skill）、非管理员 guard、非法 URL（clone 前即拒，不碰网络）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SpaceToolsContext } from '../src/pi/space/tools/context.js';
import { parseSkillUrl, sanitizeSlug, parseSkillRepo } from '../src/pi/space/skillImport.js';

function makeCtx(over: Partial<SpaceToolsContext> = {}): SpaceToolsContext {
  return {
    threadId: randomUUID(),
    versionId: randomUUID(),
    projectId: randomUUID(),
    repo: { cwd: null, issue: null, noRepo: false },
    emit: () => undefined,
    createdByUserId: randomUUID(),
    manager: false,
    ...over,
  };
}

describe('parseSkillUrl', () => {
  it('合法 github 形态 → cloneUrl + branch（branch 可含 /，如 feature/x）', () => {
    expect(parseSkillUrl('https://github.com/acme/skill-a')).toEqual({ cloneUrl: 'https://github.com/acme/skill-a.git', branch: null });
    expect(parseSkillUrl('https://github.com/acme/skill-a.git')).toEqual({ cloneUrl: 'https://github.com/acme/skill-a.git', branch: null });
    expect(parseSkillUrl('https://github.com/acme/skill-a/')).toEqual({ cloneUrl: 'https://github.com/acme/skill-a.git', branch: null });
    expect(parseSkillUrl('https://github.com/acme/skill-a/tree/v1.2.3')).toEqual({ cloneUrl: 'https://github.com/acme/skill-a.git', branch: 'v1.2.3' });
    expect(parseSkillUrl('https://github.com/acme/skill-a/tree/feature/x')).toEqual({ cloneUrl: 'https://github.com/acme/skill-a.git', branch: 'feature/x' });
    expect(parseSkillUrl('https://www.github.com/acme/skill-a')).toEqual({ cloneUrl: 'https://github.com/acme/skill-a.git', branch: null });
  });

  it('拒绝：非 https / 非 github.com / userinfo / 端口 / 多余路径', () => {
    expect(parseSkillUrl('http://github.com/acme/skill-a')).toBeNull();
    expect(parseSkillUrl('https://gitlab.com/acme/skill-a')).toBeNull();
    expect(parseSkillUrl('https://evil.com/acme/skill-a')).toBeNull();
    expect(parseSkillUrl('https://github.com.evil.com/acme/skill-a')).toBeNull();
    expect(parseSkillUrl('https://user:pw@github.com/acme/skill-a')).toBeNull();
    expect(parseSkillUrl('https://github.com:8443/acme/skill-a')).toBeNull();
    expect(parseSkillUrl('https://github.com/acme/skill-a/extra/path')).toBeNull();
    expect(parseSkillUrl('https://github.com/acme')).toBeNull();
    expect(parseSkillUrl('/acme/skill-a')).toBeNull();
    expect(parseSkillUrl('not-a-url')).toBeNull();
  });

  it('拒绝：owner/repo/ref 以 - 开头、ref 含 ..', () => {
    expect(parseSkillUrl('https://github.com/-acme/skill-a')).toBeNull();
    expect(parseSkillUrl('https://github.com/acme/-skill-a')).toBeNull();
    expect(parseSkillUrl('https://github.com/acme/skill-a/tree/--flag')).toBeNull();
    expect(parseSkillUrl('https://github.com/acme/skill-a/tree/a..b')).toBeNull();
  });
});

describe('sanitizeSlug', () => {
  it('小写、非法字符→-、折叠、去首尾 -；空 → null', () => {
    expect(sanitizeSlug('My.Repo_Name')).toBe('my-repo-name');
    expect(sanitizeSlug('  skill--a  ')).toBe('skill-a');
    expect(sanitizeSlug('-x-')).toBe('x');
    expect(sanitizeSlug('---')).toBeNull();
    expect(sanitizeSlug('')).toBeNull();
    expect(sanitizeSlug('a'.repeat(65))).toBeNull();
  });
});

describe('parseSkillRepo（本地目录，不碰网络）', () => {
  let dir: string;
  const make = async (): Promise<string> => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-skill-parse-'));
    return dir;
  };
  const cleanup = async (): Promise<void> => { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); };

  it('frontmatter name/description + scripts/ 目录 → 正确解析', async () => {
    await make();
    await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: my-skill\ndescription: "冒烟 技能:demo"\n---\n\n# 我的技能\n\n正文。');
    await fs.mkdir(path.join(dir, 'scripts'));
    await fs.writeFile(path.join(dir, 'scripts', 'run.sh'), '#!/usr/bin/env bash\necho hi\n');
    await fs.writeFile(path.join(dir, 'scripts', 'gen.py'), 'print(1)\n');
    const p = await parseSkillRepo(dir, 'repo-name-wrong');
    expect(p).toMatchObject({ name: 'my-skill', description: '冒烟 技能:demo', nameKind: 'frontmatter' });
    expect(p.body).toContain('# 我的技能');
    expect(p.files.map((f) => f.path).sort()).toEqual(['SKILL.md', 'scripts/gen.py', 'scripts/run.sh']);
    expect(p.skipped).toEqual([]);
    await cleanup();
  });

  it('frontmatter name 非法（大写）→ 回退仓库名 sanitize；无 frontmatter → 仓库名 sanitize', async () => {
    await make();
    await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: Bad_Name\ndescription: x\n---\n\n正文');
    const p1 = await parseSkillRepo(dir, 'My.Import_Skill');
    expect(p1.name).toBe('my-import-skill');
    expect(p1.nameKind).toBe('sanitized');
    await cleanup();

    await make();
    await fs.writeFile(path.join(dir, 'SKILL.md'), '# 无 frontmatter 的正文');
    const p2 = await parseSkillRepo(dir, 'plain-repo');
    expect(p2).toMatchObject({ name: 'plain-repo', nameKind: 'sanitized' });
    expect(p2.description).toBe('从 GitHub 导入：plain-repo');
    expect(p2.body).toBe('# 无 frontmatter 的正文');
    await cleanup();
  });

  it('无 scripts/ 目录 → 根目录其他文件一并纳入', async () => {
    await make();
    await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: root-skill\n---\n\n正文');
    await fs.writeFile(path.join(dir, 'tool.sh'), '#!/bin/sh\necho x\n');
    await fs.writeFile(path.join(dir, 'README.md'), 'readme');
    const p = await parseSkillRepo(dir, 'root-skill');
    expect(p.files.map((s) => s.path).sort()).toEqual(['README.md', 'SKILL.md', 'tool.sh']);
    await cleanup();
  });

  it('非法项 skip：软链 / 隐藏文件 / 超大文件', async () => {
    await make();
    await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: sk\n---\n\n正文');
    await fs.mkdir(path.join(dir, 'scripts'));
    await fs.writeFile(path.join(dir, 'scripts', 'big.js'), '// x'.padEnd(1_100_000, 'x'));
    await fs.symlink('/tmp', path.join(dir, 'scripts', 'link'));
    const p = await parseSkillRepo(dir, 'sk');
    expect(p.files.map((f) => f.path)).toEqual(['SKILL.md']);
    // 软链与超限文件都不进 files（软链直接丢弃不记 skipped，超限记原因）
    expect(p.skipped.map((s) => s.path)).toEqual(['scripts/big.js']);
    await cleanup();
  });

  it('SKILL.md 缺失 → 抛错', async () => {
    await make();
    await expect(parseSkillRepo(dir, 'empty')).rejects.toThrow('没有 SKILL.md');
    await cleanup();
  });

  it('递归导入整棵目录树（agents/ references/ eval-viewer/ 都要能装）', async () => {
    await make();
    await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: full-skill\n---\n\n正文');
    await fs.mkdir(path.join(dir, 'agents'), { recursive: true });
    await fs.writeFile(path.join(dir, 'agents', 'grader.md'), 'x');
    await fs.mkdir(path.join(dir, 'eval-viewer'), { recursive: true });
    await fs.writeFile(path.join(dir, 'eval-viewer', 'generate_review.py'), 'print(1)');
    await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
    await fs.writeFile(path.join(dir, 'assets', 'tpl.html'), '<p>');
    await fs.mkdir(path.join(dir, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(dir, 'scripts', '__init__.py'), '');
    await fs.writeFile(path.join(dir, 'scripts', 'utils.py'), 'Y = 1\n');
    await fs.writeFile(path.join(dir, 'scripts', 'run_loop.py'), 'from scripts.utils import Y\nprint(Y)\n');

    const p = await parseSkillRepo(dir, 'full-skill');
    expect(p.files.map((f) => f.path).sort()).toEqual([
      'SKILL.md', 'agents/grader.md', 'assets/tpl.html',
      'eval-viewer/generate_review.py',
      'scripts/__init__.py', 'scripts/run_loop.py', 'scripts/utils.py',
    ]);
    expect(p.skipped).toEqual([]);
    await cleanup();
  });

  it('递归导入剔除 .git/node_modules/隐藏文件/软链', async () => {
    await make();
    await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: clean\n---\n\n正文');
    await fs.mkdir(path.join(dir, '.git'), { recursive: true });
    await fs.writeFile(path.join(dir, '.git', 'config'), 'z');
    await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(dir, 'node_modules', 'x.js'), 'x');
    await fs.writeFile(path.join(dir, '.env'), 'SECRET=1');
    await fs.symlink('/tmp', path.join(dir, 'evil'));

    const p = await parseSkillRepo(dir, 'clean');
    expect(p.files.map((f) => f.path)).toEqual(['SKILL.md']);
    expect(p.skipped).toEqual([]);
    await cleanup();
  });

  it('超出 200 文件上限 → 截断且 skipped 记录原因', async () => {
    await make();
    await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: big\n---\n\n正文');
    await fs.mkdir(path.join(dir, 'scripts'), { recursive: true });
    for (let i = 0; i < 260; i++) await fs.writeFile(path.join(dir, 'scripts', `f${i}.py`), 'x');
    const p = await parseSkillRepo(dir, 'big');
    expect(p.files.length).toBeLessThanOrEqual(200);
    expect(p.skipped.length).toBeGreaterThan(0);
    expect(p.skipped[0]?.path).toBeDefined();
    await cleanup();
  });

  it('单文件超 1MB → skipped 记录原因，其余照装', async () => {
    await make();
    await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: bigfile\n---\n\n正文');
    await fs.mkdir(path.join(dir, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(dir, 'scripts', 'ok.py'), 'print(1)');
    await fs.writeFile(path.join(dir, 'scripts', 'huge.py'), 'x'.repeat(1_000_001));
    const p = await parseSkillRepo(dir, 'bigfile');
    expect(p.files.map((f) => f.path).sort()).toEqual(['SKILL.md', 'scripts/ok.py']);
    expect(p.skipped).toEqual([{ path: 'scripts/huge.py', reason: expect.stringContaining('1MB') }]);
    await cleanup();
  });
});

describe('import_skill 工具（URL 层，不触发 clone）', () => {
  it('manager 才注册 import_skill', async () => {
    const { buildSpaceTools } = await import('../src/pi/space/tools/index.js');
    expect(buildSpaceTools(makeCtx({ manager: true })).map((t) => t.name)).toContain('import_skill');
    expect(buildSpaceTools(makeCtx({ manager: false })).map((t) => t.name)).not.toContain('import_skill');
  });

  it('非管理员手动调 execute → 无管理员权限', async () => {
    const { buildImportSkillTool } = await import('../src/pi/space/tools/importSkill.js');
    const r = await buildImportSkillTool(makeCtx({ manager: false })).execute({ url: 'https://github.com/acme/skill-a' });
    expect(r).toMatchObject({ ok: false, error: '无管理员权限，不能安装全局技能（需要管理员角色）' });
  });

  it('非法 URL → clone 前即拒绝（不碰网络）', async () => {
    const { buildImportSkillTool } = await import('../src/pi/space/tools/importSkill.js');
    for (const url of ['http://github.com/acme/skill-a', 'https://evil.com/acme/skill-a', 'not-url']) {
      const r = await buildImportSkillTool(makeCtx({ manager: true })).execute({ url });
      expect(r.ok).toBe(false);
      expect((r as { error: string }).error).toContain('URL 非法');
    }
  });
});