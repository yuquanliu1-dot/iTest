/**
 * Handover protocol from skill scripts to platform artifacts.
 *
 * Convention: the script writes artifacts to `<skill>/.out/<file name>` and prints on the last stdout line
 *   __ITEST_ARTIFACTS__ [{"name":"报告.docx","path":".out/报告.docx","mime":"..."}]
 * The tool layer parses the manifest → validates paths → reads files → registerPersistentArtifact → emits SSE artifact events.
 *
 * Why the protocol lives at the run_skill_script layer: independent of the skill's origin — user-created skills
 * (manage_skill create / import_skill / settings-page editor) can produce downloadable files with zero extra configuration.
 *
 * **The path in the manifest is script-reported, untrusted input** and must be validated:
 *  1) must be under `<skill>/.out/` (the conventional location);
 *  2) must still be inside the skill directory after realpath resolution (prevents symlink escape);
 *  3) must be a regular file (not a directory/device/pipe).
 * A validation failure only skips that entry and records the reason; it never throws and aborts the whole tool call.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** Prefix of the artifact manifest line inside stdout. A distinct prefix rather than bare JSON, avoiding confusion with the script's own output. */
export const ARTIFACT_MARKER = '__ITEST_ARTIFACTS__';

/** Conventional artifact directory (relative to the skill root). Dot-prefixed → skipped by listSkillTree, so artifacts never pollute the skill file tree. */
export const ARTIFACT_OUT_DIR = '.out';

/** Size cap per artifact, preventing skill scripts from producing giant files that blow up the disk. */
export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

export interface ArtifactManifestItem {
  /** Original file name (with extension, may be non-ASCII). */
  name: string;
  /** Path relative to the skill root; must be under .out/. */
  path: string;
  /** Content-Type; inferred from the extension by default. */
  mime?: string;
  /** Optional entry count (xmind semantics: how many cases the file contains). */
  count?: number;
}

/**
 * Parse the artifact manifest from stdout.
 * Marker not found / invalid JSON / wrong shape → returns null (the caller treats the whole stdout as ordinary output, not a failure).
 * The marker line may appear anywhere in stdout (last line not enforced) — scripts often flush only after artifacts are written, so the position is unstable.
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
  // Accept both shapes: a single object or an array.
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

/** Strip the artifact manifest lines out of stdout — what the model sees should be the script's business output, not protocol noise. */
export function stripArtifactManifest(stdout: string): string {
  return stdout
    .split('\n')
    .filter((line) => !line.trim().startsWith(ARTIFACT_MARKER))
    .join('\n')
    .trim();
}

/**
 * Validate the artifact path and return the absolute path; returns null-equivalent error (with reason) when invalid.
 * Validation chain: relative path → no `..`/absolute path → must be under .out/ → still inside the skill directory after realpath → is a regular file.
 */
export async function resolveArtifactPath(skillDir: string, relPath: string): Promise<{ abs: string; size: number } | { error: string }> {
  if (path.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) return { error: '产物路径必须是相对路径' };
  const segments = relPath.split(/[\\/]/).filter((s) => s.length > 0);
  if (segments.length === 0) return { error: '产物路径为空' };
  if (segments.some((s) => s === '.' || s === '..')) return { error: '产物路径不得含 . 或 ..' };
  // Must land in the conventional .out/ directory (and not be .out itself).
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
  // After realpath it must still be inside the skill directory — guards against .out/x.docx being a symlink to /etc.
  if (realAbs !== realSkill && !realAbs.startsWith(realSkill + path.sep)) {
    return { error: '产物路径逃逸出技能目录' };
  }
  // It must also be under .out (after realpath resolution the path may fall outside .out, e.g. when .out is a symlink elsewhere).
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
