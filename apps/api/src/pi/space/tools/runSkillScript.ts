/**
 * run_skill_script：执行 skill 附带脚本（node|python3|bash|sh）。
 *  - cwd 锁定 <SKILLS_ROOT>/<skillName>/scripts；skillName 与 script 双重词法路径守卫
 *    （path.isAbsolute 先拒，normalize+startsWith 收进根）——杜绝越界写/读/执行。
 *  - 执行安全 = 超时 + 输出上限（无容器隔离）：60s 超时 / 100KB 输出，超限即 SIGKILL 整个进程组。
 *  - runtime 缺省按脚本 shebang 推断（与 read_skill 的清单 runtime 同源），可显式传参覆盖。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import type { ToolExecutor } from '../../tools.js';
import { SKILLS_ROOT, SCRIPT_RUNTIMES, isScriptRuntime } from '../skillsStore.js';
import { runtimeOfFirstLine } from './readSkill.js';

const DEFAULT_TIMEOUT_MS = Number(process.env.SKILL_SCRIPT_TIMEOUT_MS ?? 60_000);
const MAX_OUTPUT_CHARS = 100_000;
const ERROR_TAIL_CHARS = 3_000;

/** 词法路径守卫：绝对路径 reject；normalize+startsWith 必须收进 base。 */
function safeResolve(base: string, name: string): string | null {
  if (path.isAbsolute(name)) return null;
  const resolved = path.normalize(path.join(base, name));
  return resolved.startsWith(path.normalize(base) + path.sep) ? resolved : null;
}

/** 尾部截取：错误信息只回最近 N 字符（stdout/stderr 可能很长，避免撑爆模型上下文）。 */
function tail(s: string, n: number): string {
  if (s.length <= n) return s;
  return `…(${s.length - n} 字符已截断)\n${s.slice(-n)}`;
}

/** herit shebang 决定 runtime；无 shebang 回退扩展名。 */
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
  opts: { cwd: string; timeoutMs: number },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(runtime, [scriptFile, ...args], {
      cwd: opts.cwd,
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
    description: '运行某个 skill 附带的脚本（在 skill 的 scripts/ 目录下执行，runtime=node|python3|bash|sh）。先 read_skill 查看脚本清单与 runtime；runtime 缺省按脚本 shebang 推断。cwd 锁定在脚本目录禁止越界；执行受默认 60s 超时与 100KB 输出上限保护。args 为脚本命令行参数数组。',
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
      const skillDir = safeResolve(SKILLS_ROOT, skillName);
      if (!skillDir) return { ok: false, error: `skill 名称非法: ${skillName}` };
      const scriptsDir = path.join(skillDir, 'scripts');
      if (!fs.existsSync(skillDir) || !fs.existsSync(scriptsDir)) {
        return { ok: false, error: `skill 不存在或没有 scripts 目录: ${skillName}（先 read_skill 确认）` };
      }
      const scriptPath = safeResolve(scriptsDir, script);
      if (!scriptPath) return { ok: false, error: `脚本路径非法: ${script}` };
      if (!fs.existsSync(scriptPath) || !fs.statSync(scriptPath).isFile()) {
        return { ok: false, error: `脚本不存在: ${script}（在 ${skillName}/scripts 下）` };
      }
      const engine = typeof runtime === 'string' ? runtime : runtimeFor(scriptPath);
      const argv = Array.isArray(args) ? args.map((a) => String(a)) : [];
      const r = await runProcess(engine, scriptPath, argv, { cwd: scriptsDir, timeoutMs: DEFAULT_TIMEOUT_MS });
      const merged = `${r.stdout}${r.stderr}`.trim();
      if (r.spawnError) return { ok: false, error: `脚本启动失败（${engine}）: ${r.spawnError}` };
      if (r.timedOut) return { ok: false, error: `脚本执行超时(${DEFAULT_TIMEOUT_MS / 1000}s)${merged ? '\n' + tail(merged, ERROR_TAIL_CHARS) : ''}` };
      if (r.capped) return { ok: false, error: `输出超过 ${MAX_OUTPUT_CHARS} 字符上限，已终止` };
      if (r.exitCode !== 0) return { ok: false, error: `脚本退出码 ${r.exitCode}${merged ? '\n' + tail(merged, ERROR_TAIL_CHARS) : ''}` };
      return { ok: true, data: merged || '脚本执行完成（无输出）' };
    },
  };
}