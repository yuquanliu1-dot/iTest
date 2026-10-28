/**
 * skill 脚本 → 平台产物的交接协议。
 *
 * 约定：脚本把产物写到 `<skill>/.out/<文件名>`，并在 stdout 最后一行打印
 *   __ITEST_ARTIFACTS__ [{"name":"报告.docx","path":".out/报告.docx","mime":"..."}]
 * 工具层解析清单 → 校验路径 → 读文件 → registerPersistentArtifact → 发 SSE artifact 事件。
 *
 * 为什么协议挂在 run_skill_script 这一层：与 skill 来源无关——用户自建的 skill
 * （manage_skill create / import_skill / 设置页编辑器）无需任何额外配置即可产出可下载文件。
 *
 * **清单里的 path 是脚本自报的不可信输入**，必须校验：
 *  1) 必须在 `<skill>/.out/` 之下（约定位置）；
 *  2) realpath 解析后仍在技能目录内（防软链逃逸）；
 *  3) 必须是常规文件（不能是目录/设备/管道）。
 * 校验失败只跳过该条目并记录原因，绝不抛错中断整轮工具调用。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** stdout 里产物清单的前缀。用独立前缀而非裸 JSON，避免与脚本自身输出混淆。 */
export const ARTIFACT_MARKER = '__ITEST_ARTIFACTS__';

/** 产物约定目录（相对技能根）。点开头 → listSkillTree 跳过，产物不会污染技能文件树。 */
export const ARTIFACT_OUT_DIR = '.out';

/** 单个产物的体积上限，防止 skill 脚本产出巨物撑爆磁盘。 */
export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

export interface ArtifactManifestItem {
  /** 原始文件名（含扩展名，可中文）。 */
  name: string;
  /** 相对技能根的路径，必须在 .out/ 下。 */
  path: string;
  /** Content-Type；缺省按扩展名推断。 */
  mime?: string;
  /** 可选条目数（沿用 xmind 语义：文件内含多少条用例）。 */
  count?: number;
}

/**
 * 从 stdout 解析产物清单。
 * 找不到标记 / JSON 非法 / 结构不对 → 返回 null（调用方把整段 stdout 当普通输出，不视为失败）。
 * 标记行可以在 stdout 任意位置（不强制最后一行）——脚本常在产物写完后才 flush，位置不稳。
 */
export function parseArtifactManifest(stdout: string): ArtifactManifestItem[] | null {
  const lines = stdout.split('\n');
  let raw: string | null = null;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith(ARTIFACT_MARKER)) {
      raw = t.slice(ARTIFACT_MARKER.length).trim();
      break;
    }
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // 允许单个对象或数组两种形态。
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const out: ArtifactManifestItem[] = [];
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    if (typeof o.name !== 'string' || !o.name.trim()) continue;
    if (typeof o.path !== 'string' || !o.path.trim()) continue;
    const item: ArtifactManifestItem = { name: o.name.trim(), path: o.path.trim() };
    if (typeof o.mime === 'string' && o.mime.trim()) item.mime = o.mime.trim();
    if (typeof o.count === 'number' && Number.isFinite(o.count)) item.count = o.count;
    out.push(item);
  }
  return out;
}

/** 把产物清单行从 stdout 里摘掉——模型看到的应该是脚本的业务输出，不是协议噪声。 */
export function stripArtifactManifest(stdout: string): string {
  return stdout
    .split('\n')
    .filter((line) => !line.trim().startsWith(ARTIFACT_MARKER))
    .join('\n')
    .trim();
}

/**
 * 校验产物路径并返回绝对路径；不合法返回 null（附原因）。
 * 校验链：相对路径 → 无 `..`/绝对路径 → 必须在 .out/ 下 → realpath 后仍在技能目录内 → 是常规文件。
 */
export async function resolveArtifactPath(skillDir: string, relPath: string): Promise<{ abs: string; size: number } | { error: string }> {
  if (path.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) return { error: '产物路径必须是相对路径' };
  const segments = relPath.split(/[\\/]/).filter((s) => s.length > 0);
  if (segments.length === 0) return { error: '产物路径为空' };
  if (segments.some((s) => s === '.' || s === '..')) return { error: '产物路径不得含 . 或 ..' };
  // 必须落在约定目录 .out/ 下（且不是 .out 本身）。
  if (segments[0] !== ARTIFACT_OUT_DIR || segments.length < 2) {
    return { error: `产物必须写到 ${ARTIFACT_OUT_DIR}/ 目录下` };
  }

  const abs = path.resolve(skillDir, ...segments);
  let realSkill: string;
  let realAbs: string;
  try {
    realSkill = await fs.realpath(skillDir);
    realAbs = await fs.realpath(abs);
  } catch {
    return { error: '产物文件不存在' };
  }
  // realpath 后仍须在技能目录内——防 .out/x.docx 是指向 /etc 的软链。
  if (realAbs !== realSkill && !realAbs.startsWith(realSkill + path.sep)) {
    return { error: '产物路径逃逸出技能目录' };
  }
  // 还须在 .out 之下（realpath 解析后可能是 .out 外的路径，例如 .out 是指向别处的软链）。
  const realOut = path.join(realSkill, ARTIFACT_OUT_DIR);
  if (realAbs !== realOut && !realAbs.startsWith(realOut + path.sep)) {
    return { error: '产物路径逃逸出产物目录' };
  }
  let st;
  try {
    st = await fs.stat(realAbs);
  } catch {
    return { error: '产物文件不存在' };
  }
  if (!st.isFile()) return { error: '产物不是常规文件' };
  if (st.size > MAX_ARTIFACT_BYTES) {
    return { error: `产物过大（${st.size} 字节，上限 ${MAX_ARTIFACT_BYTES}）` };
  }
  return { abs: realAbs, size: st.size };
}
