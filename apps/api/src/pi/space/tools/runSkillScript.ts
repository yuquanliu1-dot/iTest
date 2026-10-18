/**
 * run_skill_script：执行 skill 附带脚本（node|python3|bash|sh）。
 *
 * 寻址：script 是**相对技能根**的路径（如 scripts/run_loop.py / eval-viewer/generate_review.py）。
 *  只写文件名且该名字不在技能根时，回退到 scripts/<name>——模型少踩一类错。
 *
 * 执行环境（2026-10-19 关键修正）：cwd = 技能根、PYTHONPATH = 技能根。
 *  官方 skill-creator 的脚本写的是 `from scripts.generate_report import ...`，上游 scripts/ 有
 *  __init__.py（是包）。旧实现把 cwd 锁在 <skill>/scripts 且不注入 PYTHONPATH，Python 在那里
 *  解析不到 scripts 包 → ModuleNotFoundError。cwd 与 PYTHONPATH 两条缺一不可（实测）。
 *
 * 安全边界：skillName/script 双重路径守卫（resolveInSkill：逐段校验 + realpath，软链逃逸也挡）；
 *  skill 必须 DB enabled=true；执行受 60s 超时 + 100KB 输出上限看管（无容器隔离）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import type { ToolExecutor } from '../../tools.js';
import { SCRIPT_RUNTIMES, assertSkillEnabled, isScriptRuntime, skillDirOf } from '../skillsStore.js';
import { resolveInSkill } from '../skillPaths.js';
import { logger } from '../../../logger.js';
import { runtimeOfFirstLine } from './readSkill.js';

const DEFAULT_TIMEOUT_MS = Number(process.env.SKILL_SCRIPT_TIMEOUT_MS ?? 60_000);
const MAX_OUTPUT_CHARS = 100_000;
const ERROR_TAIL_CHARS = 3_000;

/** 尾部截取：错误信息只回最近 N 字符（stdout/stderr 可能很长，避免撑爆模型上下文）。 */
function tail(s: string, n: number): string {
  if (s.length <= n) return s;
  return `…(${s.length - n} 字符已截断)\n${s.slice(-n)}`;
}

/** 读 shebang 决定 runtime；无 shebang 回退扩展名。 */
function runtimeFor(scriptFile: string): string {
  const firstLine = (fs.readFileSync(scriptFile, 'utf8').split('\n')[0] ?? '').trim().slice(0, 120);
  if (/^#!.*\b(?:env )?(node|python3|bash|sh)\b/.test(firstLine)) {
    return firstLine.match(/\b(?:env )?(node|python3|bash|sh)\b/)?.[1] ?? runtimeOfFirstLine(scriptFile);
  }
  return runtimeOfFirstLine(scriptFile);
}

interface RunResult {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  capped: boolean;
  exitCode: number | null;
  spawnError?: string;
}

/** spawn + 超时/输出上限看管。detached 独立进程组 → 超限可 SIGKILL 整个子树。 */
function runProcess(
  runtime: string,
  scriptFile: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(runtime, [scriptFile, ...args], {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let timedOut = false;
    let capped = false;
    const killTree = (): void => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    };
    const onData = (buf: Buffer, which: 'out' | 'err'): void => {
      const chunk = buf.toString('utf8');
      if (which === 'out') out += chunk; else err += chunk;
      if (out.length + err.length > MAX_OUTPUT_CHARS) { capped = true; killTree(); }
    };
    child.stdout?.on('data', (b) => onData(b, 'out'));
    child.stderr?.on('data', (b) => onData(b, 'err'));
    const timer = setTimeout(() => { timedOut = true; killTree(); }, opts.timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ stdout: out, stderr: err, timedOut, capped, exitCode: null, spawnError: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout: out, stderr: err, timedOut, capped, exitCode: code });
    });
  });
}

export function buildRunSkillScriptTool(): ToolExecutor {
  return {
    name: 'run_skill_script',
    description: '运行某个 skill 附带的脚本（runtime=node|python3|bash|sh）。先 read_skill 看文件树与 runtime；runtime 缺省按脚本 shebang 推断。script 是相对技能根的路径（如 scripts/run_loop.py），只写文件名时会自动回退到 scripts/ 下查找。cwd 为技能根并注入 PYTHONPATH，脚本可以用 `from scripts.x import` 包式引用。执行受默认 60s 超时与 100KB 输出上限保护。args 为脚本命令行参数数组。',
    parameters: Type.Object({
      skillName: Type.String({ minLength: 1 }),
      script: Type.String({ minLength: 1 }),
      args: Type.Optional(Type.Array(Type.String())),
      runtime: Type.Optional(Type.String()),
    }),
    execute: async (input) => {
      const { skillName, script, args, runtime } = input as {
        skillName: string; script: string; args?: unknown; runtime?: unknown;
      };
      if (runtime !== undefined && (typeof runtime !== 'string' || !isScriptRuntime(runtime))) {
        return { ok: false, error: `runtime 必须是 ${SCRIPT_RUNTIMES.join('|')}` };
      }
      // 停用/不存在的技能必须不可达——否则 enabled 只是个 UI 装饰。
      const gate = await assertSkillEnabled(skillName);
      if (gate) return { ok: false, error: gate };

      const skillDir = skillDirOf(skillName);
      if (!fs.existsSync(skillDir)) return { ok: false, error: `skill 目录不存在: ${skillName}` };

      // 脚本寻址：先按字面路径；不存在且无 "/" 时回退 scripts/<name>。
      let scriptPath = resolveInSkill(skillDir, script);
      if ((!scriptPath || !fs.existsSync(scriptPath)) && !script.includes('/')) {
        const fallback = resolveInSkill(skillDir, `scripts/${script}`);
        if (fallback && fs.existsSync(fallback)) scriptPath = fallback;
      }
      if (!scriptPath || !fs.existsSync(scriptPath) || !fs.statSync(scriptPath).isFile()) {
        return { ok: false, error: `脚本不存在或路径非法: ${script}（相对技能根，先 read_skill 看文件树清单）` };
      }

      const engine = typeof runtime === 'string' ? runtime : runtimeFor(scriptPath);
      const argv = Array.isArray(args) ? args.map((a) => String(a)) : [];
      // resolveInSkill 返回 realpath 规范化后的路径（macOS 上 /var → /private/var），
      // 故日志里的相对路径要用同样规范化过的基准，否则会打出一长串 ../。
      let base = skillDir;
      try { base = fs.realpathSync.native(skillDir); } catch { /* 目录刚被删：日志用原值即可 */ }
      logger.info({ skillName, script: path.relative(base, scriptPath), argv }, 'run_skill_script');
      // cwd = 技能根（不是 scripts/）且 PYTHONPATH 指向技能根——这两条合起来才能让
      // `from scripts.xxx import` 成立（实测：只给 cwd=scripts 必失败）。
      const r = await runProcess(engine, scriptPath, argv, {
        cwd: skillDir,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        env: { ...process.env, PYTHONPATH: skillDir },
      });
      const merged = `${r.stdout}${r.stderr}`.trim();
      if (r.spawnError) return { ok: false, error: `脚本启动失败（${engine}）: ${r.spawnError}` };
      if (r.timedOut) return { ok: false, error: `脚本执行超时(${DEFAULT_TIMEOUT_MS / 1000}s)${merged ? '\n' + tail(merged, ERROR_TAIL_CHARS) : ''}` };
      if (r.capped) return { ok: false, error: `输出超过 ${MAX_OUTPUT_CHARS} 字符上限，已终止` };
      if (r.exitCode !== 0) return { ok: false, error: `脚本退出码 ${r.exitCode}${merged ? '\n' + tail(merged, ERROR_TAIL_CHARS) : ''}` };
      return { ok: true, data: merged || '脚本执行完成（无输出）' };
    },
  };
}
