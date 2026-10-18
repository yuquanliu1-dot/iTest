import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readSkillDir, buildReadSkillTool, buildSkillsSectionContent, skillsRootOf } from '../src/pi/space/tools/readSkill.js';

let ws: string;

beforeAll(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-skills-'));
  await fs.mkdir(path.join(ws, '.pi', 'skills', 'echo', 'scripts'), { recursive: true });
  await fs.writeFile(path.join(ws, '.pi', 'skills', 'echo', 'SKILL.md'), '---\nname: echo\ndescription: 回显\n---\n正文EchoBody');
  await fs.writeFile(path.join(ws, '.pi', 'skills', 'echo', 'scripts', 'a.js'), 'console.log(1)');
});

afterAll(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

describe('read_skill（S2）', () => {
  it('读 SKILL.md 正文 + scripts 清单', () => {
    const hit = readSkillDir(skillsRootOf(ws), 'echo');
    expect(hit?.body).toContain('正文EchoBody');
    expect(hit?.scripts).toEqual(['a.js']);
  });

  it('路径逃逸双守卫：../ 与绝对路径都拒绝', () => {
    expect(readSkillDir(skillsRootOf(ws), '..')).toBeNull();
    expect(readSkillDir(skillsRootOf(ws), '/etc')).toBeNull();
    expect(readSkillDir(skillsRootOf(ws), '../echo')).toBeNull();
    expect(readSkillDir(skillsRootOf(ws), 'echo/../../etc')).toBeNull();
  });

  it('buildReadSkillTool.execute：命中返回正文 JSON；不存在返回错误', async () => {
    const tool = buildReadSkillTool({ workspaceDir: ws } as never);
    const ok = await tool.execute({ skillName: 'echo' });
    expect(ok.ok).toBe(true);
    expect(JSON.parse((ok as { data: string }).data)).toMatchObject({ name: 'echo' });
    const miss = await tool.execute({ skillName: 'nope' });
    expect(miss.ok).toBe(false);
  });

  it('buildSkillsSectionContent：available_skills XML 只含 catalog（无正文）+ read_skill 用法', () => {
    const s = buildSkillsSectionContent([{ name: 'echo', description: '回显', location: '/abs/echo/SKILL.md' }]);
    expect(s).toContain('<available_skills>');
    expect(s).toContain('name="echo"');
    expect(s).toContain('read_skill');
    expect(s).not.toContain('正文EchoBody'); // catalog-only，正文靠 read_skill 取
  });
});