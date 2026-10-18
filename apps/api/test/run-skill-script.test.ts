import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ToolExecutor } from '../src/pi/tools.js';

/** 用动态 import + PI_DATA_DIR 指向临时目录，让 SKILLS_ROOT 落在可控路径（模块级常量在导入时解析）。 */
let buildTool: () => ToolExecutor;
let skillsRoot: string;
let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-runskill-'));
  process.env.PI_DATA_DIR = path.join(root, 'pi-data');
  process.env.SKILL_SCRIPT_TIMEOUT_MS = '3000';
  vi.resetModules();
  const store = await import('../src/pi/space/skillsStore.js');
  skillsRoot = store.SKILLS_ROOT;
  const mod = await import('../src/pi/space/tools/runSkillScript.js');
  buildTool = mod.buildRunSkillScriptTool;
  // 种子技能目录（模拟 materializeSkills 产物）
  await fs.mkdir(path.join(skillsRoot, 'echo', 'scripts'), { recursive: true });
  await fs.writeFile(path.join(skillsRoot, 'echo', 'scripts', 'a.js'), 'console.log("ARG:" + (process.argv[2] ?? ""))');
  await fs.writeFile(path.join(skillsRoot, 'echo', 'scripts', 'b.py'), 'import sys\nprint("PY:" + (sys.argv[1] if len(sys.argv) > 1 else "PY"))');
  await fs.writeFile(path.join(skillsRoot, 'echo', 'scripts', 'sleep.sh'), 'sleep 30');
  await fs.writeFile(path.join(skillsRoot, 'echo', 'scripts', 'big.js'), 'console.log("x".repeat(120000))');
  await fs.writeFile(path.join(skillsRoot, 'echo', 'scripts', 'fail.js'), 'process.exit(3)');
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('run_skill_script', () => {
  it('node 运行 + args 透传；省略 runtime 按 shebang/扩展名推断', async () => {
    const tool = buildTool();
    const ok = await tool.execute({ skillName: 'echo', script: 'a.js', args: ['hello'] });
    expect(ok.ok).toBe(true);
    expect((ok as { data: string }).data).toContain('ARG:hello');
  });

  it('runtime=python3 可用（shebang 缺省推断）', async () => {
    const tool = buildTool();
    const ok = await tool.execute({ skillName: 'echo', script: 'b.py' });
    expect(ok.ok).toBe(true);
    expect((ok as { data: string }).data).toContain('PY:PY');
    const withArg = await tool.execute({ skillName: 'echo', script: 'b.py', args: ['z'] });
    expect((withArg as { data: string }).data).toContain('PY:z');
  });

  it('显式 runtime 非法 → 错误', async () => {
    const tool = buildTool();
    const r = await tool.execute({ skillName: 'echo', script: 'a.js', runtime: 'perl' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('runtime 必须是');
  });

  it('输出超过上限 → 终止并报错', async () => {
    const tool = buildTool();
    const r = await tool.execute({ skillName: 'echo', script: 'big.js' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('输出超过');
  });

  it('非零退出码 → 错误含 stdout/stderr 尾部', async () => {
    const tool = buildTool();
    const r = await tool.execute({ skillName: 'echo', script: 'fail.js' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('退出码 3');
  });

  it('超时 → SIGKILL 并报超时', async () => {
    const tool = buildTool();
    const r = await tool.execute({ skillName: 'echo', script: 'sleep.sh' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('超时');
  }, 10_000);

  it('路径守卫：skillName/script 逃逸、不存在都拒绝', async () => {
    const tool = buildTool();
    expect((await tool.execute({ skillName: '../echo', script: 'a.js' })).ok).toBe(false);
    expect((await tool.execute({ skillName: '/etc', script: 'passwd' })).ok).toBe(false);
    expect((await tool.execute({ skillName: 'echo', script: '../../etc/passwd' })).ok).toBe(false);
    expect((await tool.execute({ skillName: 'echo', script: '/tmp/x' })).ok).toBe(false);
    expect((await tool.execute({ skillName: 'echo', script: 'x/../../etc/passwd' })).ok).toBe(false); // ../ 越界
    expect((await tool.execute({ skillName: 'nope', script: 'a.js' })).ok).toBe(false);
    expect((await tool.execute({ skillName: 'echo', script: 'missing.sh' })).ok).toBe(false);
  });
});