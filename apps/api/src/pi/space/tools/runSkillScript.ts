/**
 * run_skill_script: executes a skill's bundled scripts (node|python3|bash|sh).
 *
 * Addressing: script is a path **relative to the skill root** (e.g. scripts/run_loop.py / eval-viewer/generate_review.py).
 *  A bare filename that doesn't exist at the skill root falls back to scripts/<name> — one fewer class of model mistake.
 *
 * Execution environment (2026-10-19 key fix): cwd = skill root, PYTHONPATH = skill root.
 *  The official skill-creator scripts do `from scripts.generate_report import ...`, and the upstream scripts/ has
 *  an __init__.py (it is a package). The old implementation pinned cwd to <skill>/scripts and injected no PYTHONPATH,
 *  so Python couldn't resolve the scripts package there → ModuleNotFoundError. cwd and PYTHONPATH are both required (measured).
 *
 * Safety boundary: dual path guard on skillName/script (resolveInSkill: per-segment validation + realpath, symlink escapes blocked too);
 *  the skill must be enabled=true in the DB; execution is watched by a 60s timeout + 100KB output cap (no container isolation).
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
import { parseArtifactManifest, resolveArtifactPath, stripArtifactManifest, type ArtifactManifestItem } from '../skillArtifacts.js';
import { registerPersistentArtifact } from '../artifacts.js';
import type { SpaceToolsContext } from './context.js';

const DEFAULT_TIMEOUT_MS = Number(process.env.SKILL_SCRIPT_TIMEOUT_MS ?? 60_000);
const MAX_OUTPUT_CHARS = 100_000;
const ERROR_TAIL_CHARS = 3_000;

/** Tail extraction: error messages return only the last N chars (stdout/stderr can be long; avoids blowing up the model context). */
function tail(s: string, n: number): string {
  if (s.length <= n) return s;
  return `…(${s.length - n} 字符已截断)\n${s.slice(-n)}`;
}

/** Reads the shebang to decide the runtime; no shebang → fall back to the extension. */
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

/** spawn + timeout/output-cap supervision. detached spawns its own process group → on overrun the whole subtree can be SIGKILLed. */
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

export function buildRunSkillScriptTool(ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'run_skill_script',
    description: '运行某个 skill 附带的脚本（runtime=node|python3|bash|sh）。先 read_skill 看文件树与 runtime；runtime 缺省按脚本 shebang 推断。script 是相对技能根的路径（如 scripts/run_loop.py），只写文件名时会自动回退到 scripts/ 下查找。cwd 为技能根并注入 PYTHONPATH，脚本可以用 `from scripts.x import` 包式引用。执行受默认 60s 超时与 100KB 输出上限保护。args 为脚本命令行参数数组。脚本若产出文件（如生成 Word/Excel 报告），把文件写到技能的 .out/ 目录并在 stdout 打印一行 __ITEST_ARTIFACTS__ [{"name":"文件名.docx","path":".out/文件名.docx"}]，平台会把它变成用户可下载的下载卡。',
    parameters: Type.Object({
      skillName: Type.String({ minLength: 1 }),
      script: Type.String({ minLength: 1 }),
      args: Type.Optional(Type.Array(Type.String())),
      runtime: Type.Optional(Type.String()),
    }),
    promptGuidelines: [
      '脚本产出文件时：文件写到 <skill>/.out/ 下，stdout 打印一行 __ITEST_ARTIFACTS__ [{"name":"报告.docx","path":".out/报告.docx"}]（name 为用户可读的文件名，含扩展名）。平台据此生成下载卡，用户点击下载。',
      '产物协议与文件格式无关：docx/xlsx/pdf/png/csv 皆可。name 里的扩展名决定下载文件的 MIME。',
    ],
    execute: async (input) => {
      const { skillName, script, args, runtime } = input as {
        skillName: string; script: string; args?: unknown; runtime?: unknown;
      };
      if (runtime !== undefined && (typeof runtime !== 'string' || !isScriptRuntime(runtime))) {
        return { ok: false, error: `runtime 必须是 ${SCRIPT_RUNTIMES.join('|')}` };
      }
      // Disabled/nonexistent skills must be unreachable — otherwise enabled is mere UI decoration.
      const gate = await assertSkillEnabled(skillName);
      if (gate) return { ok: false, error: gate };

      const skillDir = skillDirOf(skillName);
      if (!fs.existsSync(skillDir)) return { ok: false, error: `skill 目录不存在: ${skillName}` };

      // Script addressing: the literal path first; if missing and there's no "/", fall back to scripts/<name>.
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
      // resolveInSkill returns the realpath-normalized path (on macOS /var → /private/var),
      // so the relative path in logs must use the same normalized base, otherwise it prints a long ../ chain.
      let base = skillDir;
      try { base = fs.realpathSync.native(skillDir); } catch { /* directory just deleted: the original value is fine for logging */ }
      logger.info({ skillName, script: path.relative(base, scriptPath), argv }, 'run_skill_script');
      // cwd = skill root (not scripts/) and PYTHONPATH pointing at the skill root — only the two together make
      // `from scripts.xxx import` work (measured: cwd=scripts alone always fails).
      // PYTHONDONTWRITEBYTECODE=1: otherwise Python generates __pycache__/*.pyc inside the skill directory;
      // the skill directory is the content source of truth, so running a script once would add binary entries
      // to the file tree out of nowhere (measured 18 files → 24), and dirty the "skill dir = user-edited content" premise.
      const r = await runProcess(engine, scriptPath, argv, {
        cwd: skillDir,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        env: { ...process.env, PYTHONPATH: skillDir, PYTHONDONTWRITEBYTECODE: '1' },
      });
      const merged = `${r.stdout}${r.stderr}`.trim();
      if (r.spawnError) return { ok: false, error: `脚本启动失败（${engine}）: ${r.spawnError}` };
      if (r.timedOut) return { ok: false, error: `脚本执行超时(${DEFAULT_TIMEOUT_MS / 1000}s)${merged ? '\n' + tail(merged, ERROR_TAIL_CHARS) : ''}` };
      if (r.capped) return { ok: false, error: `输出超过 ${MAX_OUTPUT_CHARS} 字符上限，已终止` };
      if (r.exitCode !== 0) return { ok: false, error: `脚本退出码 ${r.exitCode}${merged ? '\n' + tail(merged, ERROR_TAIL_CHARS) : ''}` };

      // Artifact handoff: the __ITEST_ARTIFACTS__ manifest in script stdout → persist → download card.
      // A missing/invalid manifest is skipped silently (the script is just an ordinary script); the existing return semantics are unchanged.
      const manifest = parseArtifactManifest(merged);
      if (!manifest || manifest.length === 0) {
        return { ok: true, data: merged || '脚本执行完成（无输出）' };
      }
      const collected = await collectArtifacts(ctx, skillName, skillDir, manifest);
      const text = stripArtifactManifest(merged);
      if (collected.registered.length === 0) {
        // Not a single artifact succeeded: report the failure reasons back so the model can retry with adjusted parameters.
        return {
          ok: true,
          data: `${text ? text + '\n' : ''}产物注册失败：${collected.failed.join('；')}`,
        };
      }
      const okDesc = collected.registered.map((a) => `「${a.name}」`).join('、');
      const failNote = collected.failed.length > 0 ? `\n（${collected.failed.length} 个产物失败：${collected.failed.join('；')}）` : '';
      return {
        ok: true,
        data: `${text ? text + '\n' : ''}已生成 ${collected.registered.length} 个文件（${okDesc}），下载卡已推送给用户${failNote}`,
      };
    },
  };
}

/**
 * Artifact manifest → persist → SSE artifact events.
 * A failed artifact is skipped individually with its reason recorded; the rest are unaffected and the whole tool call doesn't fail.
 */
async function collectArtifacts(
  ctx: SpaceToolsContext,
  skillName: string,
  skillDir: string,
  manifest: ArtifactManifestItem[],
): Promise<{ registered: Array<{ name: string; size: number }>; failed: string[] }> {
  const registered: Array<{ name: string; size: number }> = [];
  const failed: string[] = [];
  for (const item of manifest) {
    const resolved = await resolveArtifactPath(skillDir, item.path);
    if ('error' in resolved) {
      failed.push(`${item.name}: ${resolved.error}`);
      continue;
    }
    let buf: Buffer;
    try {
      buf = await fs.promises.readFile(resolved.abs);
    } catch (e) {
      failed.push(`${item.name}: 读取失败（${e instanceof Error ? e.message : String(e)}）`);
      continue;
    }
    try {
      const token = await registerPersistentArtifact(
        buf,
        { name: item.name, mime: item.mime, count: item.count },
        {
          threadId: ctx.threadId,
          versionId: ctx.versionId,
          projectId: ctx.projectId,
          skillName,
          createdByUserId: ctx.createdByUserId,
        },
      );
      ctx.emit({ type: 'artifact', token, name: item.name, size: buf.length, ...(item.count !== undefined ? { count: item.count } : {}) });
      registered.push({ name: item.name, size: buf.length });
    } catch (e) {
      failed.push(`${item.name}: 落库失败（${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  return { registered, failed };
}
