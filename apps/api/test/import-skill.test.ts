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
    expect(p.scripts.map((s) => [s.filename, s.runtime])).toEqual([['gen.py', 'python3'], ['run.sh', 'bash']]);
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

  it('无 scripts/ 目录 → 取根目录脚本（排除 SKILL.md/隐藏）', async () => {
    await make();
    await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: root-skill\n---\n\n正文');
    await fs.writeFile(path.join(dir, 'tool.sh'), '#!/bin/sh\necho x\n');
    await fs.writeFile(path.join(dir, '.hidden.js'), 'console.log(1)');
    await fs.writeFile(path.join(dir, 'README.md'), 'readme');
    const p = await parseSkillRepo(dir, 'root-skill');
    expect(p.scripts.map((s) => s.filename)).toEqual(['tool.sh']);
    await cleanup();
  });

  it('非法项 skip：perl shebang / 非法文件名 / 超大 / 未知扩展', async () => {
    await make();
    await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: sk\n---\n\n正文');
    await fs.mkdir(path.join(dir, 'scripts'));
    await fs.writeFile(path.join(dir, 'scripts', 'go.pl'), '#!/usr/bin/perl\nprint 1;\n');
    await fs.writeFile(path.join(dir, 'scripts', 'a&b.sh'), '#!/bin/bash\necho x\n');
    await fs.writeFile(path.join(dir, 'scripts', 'big.js'), '// x'.padEnd(1_100_000, 'x'));
    await fs.writeFile(path.join(dir, 'scripts', 'noext'), 'hello');
    const p = await parseSkillRepo(dir, 'sk');
    expect(p.scripts).toEqual([]);
    expect(p.skipped.map((s) => s.filename).sort()).toEqual(['a&b.sh', 'big.js', 'go.pl', 'noext']);
    expect(p.skipped.every((s) => s.reason)).toBe(true);
    await cleanup();
  });

  it('SKILL.md 缺失 → 抛错', async () => {
    await make();
    await expect(parseSkillRepo(dir, 'empty')).rejects.toThrow('没有 SKILL.md');
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