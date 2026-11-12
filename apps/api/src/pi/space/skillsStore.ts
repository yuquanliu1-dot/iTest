/**
 * AI assistant Skills globally-shared storage (managed by the system settings page; every space thread loads all enabled skills).
 *
 *  **The file system is the source of truth**: skill bodies and the full directory tree live under SKILLS_ROOT/<slug>/ (.data/skills);
 *  the DB (assistant_skills) stores only three metadata items: name/description/enabled. 2026-10-19 storage flip:
 *  the old model flattened the body and scripts into the body/scripts columns, dropping directories like agents/ references/ assets/ eval-viewer/
 *  entirely, and scripts could only be flat scripts/<filename> — the official skill-creator's packaged
 *  python imports therefore could not work.
 *
 *  .data is a docker volume (docker-compose.yml mounts itest-data:/repo/apps/api/.data); all api replicas
 *  see the same files — the old comment "no shared file system across replicas" was wrong, corrected here. **The cost**: that volume is
 *  host-local, so a future multi-machine deployment would silently split the skill library; before that migration it must be swapped for object storage.
 *
 *  Never rm SKILLS_ROOT as a whole — it is the only copy of the skill bodies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assistantSkills } from '../../db/schema.js';
import { WORKSPACES_ROOT } from '../repo.js';

/** Runtimes allowed for scripts (mirrors the system executor; the container image ships node/python3/bash/sh). */
export const SCRIPT_RUNTIMES = ['node', 'python3', 'bash', 'sh'] as const;
export type ScriptRuntime = (typeof SCRIPT_RUNTIMES)[number];

/** Global skills root: .data/skills (sibling of WORKSPACES_ROOT=.data/workspaces). */
export const SKILLS_ROOT = path.join(path.dirname(WORKSPACES_ROOT), 'skills');

/** Skill name (slug) guard: same source as pi-coding-agent loadSkills validateName (the name = directory name +
 *  the argument of read_skill/run_skill_script, so it must be installable into the catalog by the skills loader).
 *  Lowercase a-z/digits/hyphens only; no leading/trailing -, no consecutive --, ≤64. */
export function isSafeSkillName(name: string): boolean {
  return (
    /^[a-z0-9-]+$/.test(name)
    && name.length <= 64
    && !name.startsWith('-')
    && !name.endsWith('-')
    && !name.includes('--')
  );
}

export function isScriptRuntime(r: string): r is ScriptRuntime {
  return (SCRIPT_RUNTIMES as readonly string[]).includes(r);
}

/** Absolute path of a single skill directory (name must be a DB slug that passed isSafeSkillName). */
export function skillDirOf(name: string): string {
  return path.join(SKILLS_ROOT, name);
}

/** Array of absolute directory paths for enabled=true skills, fed directly to the pi loader.
 *  Per-skill directories are passed instead of SKILLS_ROOT: pi's loadSkillsFromDirInternal stops as soon as it sees a SKILL.md and doesn't descend further,
 *  so disabled skills and orphan directories are naturally invisible. */
export async function loadEnabledSkillDirs(): Promise<string[]> {
  const rows = await db.select({ name: assistantSkills.name })
    .from(assistantSkills)
    .where(eq(assistantSkills.enabled, true))
    .orderBy(asc(assistantSkills.name));
  return rows.map((r) => skillDirOf(r.name));
}

/** Admission gate for read_skill / run_skill_script: the skill must exist and be DB enabled=true, otherwise unreachable. */
export async function assertSkillEnabled(name: string): Promise<string | null> {
  const row = (await db.select({ enabled: assistantSkills.enabled })
    .from(assistantSkills)
    .where(eq(assistantSkills.name, name))
    .limit(1))[0];
  if (!row) return `skill 不存在: ${name}`;
  if (!row.enabled) return `skill 已停用: ${name}`;
  return null;
}

export interface SkillTreeNode {
  /** posix path relative to the skill root. */
  path: string;
  kind: 'file' | 'dir';
  size: number;
  runtime?: string;
}

const MAX_TREE_ENTRIES = 200;
const MAX_TREE_DEPTH = 8;

/**
 * Directory names skipped when listing the tree.
 *
 * node_modules: dependency directory, not skill content.
 * __pycache__: bytecode cache auto-generated the first time Python runs a script. When a skill script is
 *   executed via run_skill_script, Python writes .pyc files into the script's directory — this makes the "file tree"
 *   sprout several binary entries out of nowhere after one run (measured: skill-creator 18 files → 24);
 *   what the model sees becomes a pile of noise unrelated to the skill's semantics. Content is the source of truth; bytecode is not.
 */
const SKIP_DIR_NAMES = new Set(['node_modules', '__pycache__']);

/** Recursively list the tree. .git/node_modules/hidden files/symlinks are always skipped; truncated on overflow of count or depth.
 *  The list page calls this every round, so it must only readdir/stat and never read content. */
export function listSkillTree(skillDir: string): SkillTreeNode[] {
  const out: SkillTreeNode[] = [];
  const state = { truncated: false };
  walk(skillDir, '', 0);
  return out;

  function walk(abs: string, rel: string, depth: number): void {
    if (state.truncated) return;
    if (depth > MAX_TREE_DEPTH) { state.truncated = true; return; }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || SKIP_DIR_NAMES.has(e.name)) continue;
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        // Symlinks don't enter the tree: even pointing inside the tree, they create two divergent views between the file tree and actual reads, and easily become an escape surface.
        continue;
      }
      if (isDir) {
        out.push({ path: childRel, kind: 'dir', size: 0 });
        walk(childAbs, childRel, depth + 1);
      } else if (isFile) {
        let size = 0;
        try { size = fs.statSync(childAbs).size; } catch { /* ignore when size is unavailable */ }
        out.push({ path: childRel, kind: 'file', size, runtime: runtimeOfPath(childRel) });
      }
      if (out.length >= MAX_TREE_ENTRIES) { state.truncated = true; return; }
    }
  }
}

/** runtime is only given to executable extensions, never mislabeling assets/*.html etc. as node. */
function runtimeOfPath(rel: string): string | undefined {
  if (/\.py$/i.test(rel)) return 'python3';
  if (/\.sh$/i.test(rel)) return 'bash';
  if (/\.(js|mjs|cjs)$/i.test(rel)) return 'node';
  return undefined;
}

/** List page stats: count only numbers and bytes, never read content. */
export function countSkillFiles(skillDir: string): { fileCount: number; totalBytes: number } {
  let fileCount = 0;
  let totalBytes = 0;
  for (const n of listSkillTree(skillDir)) {
    if (n.kind === 'file') { fileCount++; totalBytes += n.size; }
  }
  return { fileCount, totalBytes };
}

/** Orphan directory names that exist on disk but have no registered DB row (shown as "unregistered" in the settings page; never enter the catalog, never auto-adopted). */
export function listOrphanSkillDirs(registeredNames: string[]): string[] {
  const known = new Set(registeredNames);
  try {
    return fs.readdirSync(SKILLS_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && isSafeSkillName(e.name) && !known.has(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
