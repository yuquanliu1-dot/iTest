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
  // runSkillScript 会调 assertSkillEnabled 查 DB；本文件不连 PG，只 mock 掉这一处。
  vi.doMock('../src/pi/space/skillsStore.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/pi/space/skillsStore.js')>();
    return { ...actual, assertSkillEnabled: async () => null };
  });
  const store = await import('../src/pi/space/skillsStore.js');
  skillsRoot = store.SKILLS_ROOT;
  const mod = await import('../src/pi/space/tools/runSkillScript.js');
  buildTool = mod.buildRunSkillScriptTool;
  // 种子技能目录（模拟 import 产物：目录树原样保留）
  await fs.mkdir(path.join(skillsRoot, 'echo', 'scripts'), { recursive: true });
  await fs.mkdir(path.join(skillsRoot, 'echo', 'eval-viewer'), { recursive: true });
  await fs.writeFile(path.join(skillsRoot, 'echo', 'SKILL.md'), '---\nname: echo\n---\n\nbody');
  await fs.writeFile(path.join(skillsRoot, 'echo', 'scripts', 'a.js'), 'console.log("ARG:" + (process.argv[2] ?? ""))');
  await fs.writeFile(path.join(skillsRoot, 'echo', 'scripts', 'b.py'), 'import sys\nprint("PY:" + (sys.argv[1] if len(sys.argv) > 1 else "PY"))');
  await fs.writeFile(path.join(skillsRoot, 'echo', 'scripts', 'sleep.sh'), 'sleep 30');
  await fs.writeFile(path.join(skillsRoot, 'echo', 'scripts', 'big.js'), 'console.log("x".repeat(120000))');
  await fs.writeFile(path.join(skillsRoot, 'echo', 'scripts', 'fail.js'), 'process.exit(3)');
  await fs.writeFile(path.join(skillsRoot, 'echo', 'eval-viewer', 'gen.py'), 'print("from eval-viewer")\n');
  // 包式 import 场景：scripts/ 是包（上游 skill-creator 就是这个形态）
  await fs.writeFile(path.join(skillsRoot, 'echo', 'scripts', '__init__.py'), '');
  await fs.writeFile(path.join(skillsRoot, 'echo', 'scripts', 'util.py'), 'MARKER = 42\n');
  await fs.writeFile(path.join(skillsRoot, 'echo', 'scripts', 'pkgmain.py'), 'from scripts.util import MARKER\nprint("got", MARKER)\n');
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

  it('包式 import 生效：cwd=技能根 + PYTHONPATH 让 `from scripts.x import` 可用', async () => {
    // 这是 skill-creator 的 quick_validate.py / package_skill.py 之前跑不起来的那一类
    const tool = buildTool();
    const r = await tool.execute({ skillName: 'echo', script: 'scripts/pkgmain.py' });
    expect(r.ok).toBe(true);
    expect((r as { data: string }).data).toContain('got 42');
  });

  it('裸文件名回退到 scripts/<name>', async () => {
    const tool = buildTool();
    const r = await tool.execute({ skillName: 'echo', script: 'a.js', args: ['hi'] });
    expect(r.ok).toBe(true);
    expect((r as { data: string }).data).toContain('ARG:hi');
  });

  it('scripts/ 之外的脚本可执行（eval-viewer/ 这种同级目录）', async () => {
    const tool = buildTool();
    const r = await tool.execute({ skillName: 'echo', script: 'eval-viewer/gen.py' });
    expect(r.ok).toBe(true);
    expect((r as { data: string }).data).toContain('from eval-viewer');
  });
});