/**
 * Skill directory-tree path guard + atomic writes. The repo-wide single entry point for skill file path validation: the REST file tree API /
 * read_skill / run_skill_script / import_skill persistence all go through here.
 *
 * Why not the off-the-shelf purely lexical approach: normalize+startsWith in runSkillScript only blocks ../ and absolute paths;
 * if <skill>/scripts is a symlink it tunnels straight into /etc. This module adds realpath resolution and validates by "segment" rather than the whole string
 * (.git / node_modules / hidden files rejected per segment, not just the first segment).
 *
 * No recursive mkdir: all parent directories of a write target must already exist — the directory structure comes from import (a trusted source),
 * not from paths typed by a person in the settings page.
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_REL_LEN = 512;
const FORBIDDEN_SEGMENTS = new Set(['.git', 'node_modules']);

/** Returns the absolute path when rel is legal, null when illegal. opts.requireParentExisting=true is for write paths. */
export function resolveInSkill(
  root: string,
  rel: string,
  opts: { requireParentExisting?: boolean } = {},
): string | null {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > MAX_REL_LEN) return null;
  if (rel.includes('\0') || rel.includes('\\')) return null;
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return null;

  const segments = rel.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  for (const seg of segments) {
    if (seg === '.' || seg === '..') return null;
    if (seg.startsWith('.')) return null;
    if (FORBIDDEN_SEGMENTS.has(seg)) return null;
  }

  const realRoot = realOrSelf(root);
  const abs = path.resolve(realRoot, ...segments);
  if (abs !== realRoot && !abs.startsWith(realRoot + path.sep)) return null;

  // realpath throws when the target doesn't exist yet; instead resolve via the "deepest existing ancestor" and re-attach the tail before validating.
  const realAbs = realpathDeepestExisting(abs);
  if (realAbs !== realRoot && !realAbs.startsWith(realRoot + path.sep)) return null;

  if (opts.requireParentExisting && !fs.existsSync(path.dirname(abs))) return null;
  return abs;
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** abs may not exist yet: walk up to the first existing ancestor, realpath it, then re-attach the tail. */
function realpathDeepestExisting(abs: string): string {
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...tail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs; // nothing exists all the way to the root; let the caller's startsWith check fail
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/** Atomic write: temp file in the same directory + rename (same filesystem, rename is atomic). A mid-write kill never leaves a half-written file. */
export function writeSkillFileAtomic(absPath: string, content: string): void {
  const dir = path.dirname(absPath);
  const tmp = path.join(dir, `.${path.basename(absPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, absPath);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* already cleaned up */ }
    throw e;
  }
}

/** Delete a skill directory: the dir name must be a valid slug, and its parent must be exactly root (prevents a future refactor from wiping the whole root). */
export function removeSkillDir(root: string, name: string): void {
  const dir = path.join(root, name);
  if (path.dirname(dir) !== path.resolve(root)) throw new Error(`拒绝删除非技能目录: ${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
}
