/**
 * skill_import shared layer: fetch a skill repo from GitHub → validate → parse → (preview | persist).
 *
 * Security design:
 *  - Structural SSRF avoidance: after URL parsing, host must be exactly ∈ {github.com, www.github.com}, otherwise rejected —
 *    no user-controllable hostnames are ever resolved, so the DNS rebinding / private-network probing surface simply does not exist.
 *  - Fetching uses `git clone --depth 1` (spawn array args, no shell); branch/ref passes a lexical regex whitelist
 *    (^[A-Za-z0-9._/-]+$ and not starting with -), eliminating argument injection.
 *  - Clones into an mkdtemp temp dir, cleaned up in finally; 60s timeout SIGKILLs the process group.
 *  - Decoupling: parseSkillRepo is a pure function (locally unit-testable, no network); the fetch layer stays thin.
 *
 * Repo layout (since 2026-10-19: **the entire directory tree is persisted as-is**):
 *  - Root SKILL.md (required) → the first file in the directory; frontmatter name/description still go through DB metadata columns
 *  - All other files are collected recursively: agents/ references/ assets/ eval-viewer/ scripts/ … (the official skill-creator's
 *    19 files are exactly this shape; the old implementation only collected flat files under scripts/, dropping the other 4 directories and 9 files entirely)
 *  - Excluded: .git / node_modules / hidden files / symlinks; a single file >1MB or >200 total files → record skipped and continue
 *  - runtime is no longer stored nor an admission condition (inferred from shebang at execution time), so .md/.html can all be installed
 *
 * name resolution order: frontmatter name (must be a valid slug) → repo short name sanitized → still invalid → error asking the user to provide a name= override.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { registerSkill } from './skillsService.js';
import { skillDirOf } from './skillsStore.js';
import { resolveInSkill, writeSkillFileAtomic } from './skillPaths.js';

const SKILL_MD_MAX_BYTES = 200_000;
const FILE_MAX_BYTES = 1_000_000;
const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 8_000_000;
const MAX_DEPTH = 8;
const MAX_DESCRIPTION_CHARS = 500;
const CLONE_TIMEOUT_MS = 60_000;

export interface SkillImportFile { path: string; content: string; size: number }
export interface SkillImportSkipped { path: string; reason: string }

export interface ParsedSkillImport {
  name: string;
  description: string;
  body: string;
  /** Full file tree relative to the skill root (posix separators), including SKILL.md itself. */
  files: SkillImportFile[];
  skipped: SkillImportSkipped[];
  /** Where name came from: frontmatter hit / repo name sanitized / user name override (install side). */
  nameKind: 'frontmatter' | 'sanitized';
}

/** URL → (cloneUrl, branch?). Invalid URL / not github.com / wrong path structure → null.
 *  Host whitelist is hardcoded, default port 443; userinfo / non-https / non-443 ports are all rejected. */
export function parseSkillUrl(raw: string): { cloneUrl: string; branch: string | null } | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 300) return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.port !== '' && u.port !== '443') return null;
  if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') return null;
  // path: /owner/repo[.git][/tree/<ref>][/]
  const m = /^\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([A-Za-z0-9._/-]+))?\/?$/.exec(u.pathname);
  if (!m) return null;
  const owner = m[1]!;
  const repo = m[2]!;
  if (!owner || !repo || owner.startsWith('-') || repo.startsWith('-')) return null;
  const branch = m[3] ?? null;
  if (branch && (branch.startsWith('-') || branch.includes('..'))) return null;
  return { cloneUrl: `https://github.com/${owner}/${repo}.git`, branch };
}

/** Sanitize an untrusted name into a valid slug: lowercase, illegal chars → -, collapse consecutive -, trim leading/trailing -. Empty → null. */
export function sanitizeSlug(raw: string): string | null {
  const s = (raw || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  return s.length > 0 && s.length <= 64 ? s : null;
}

/** Parse the name/description scalars of YAML-like frontmatter (simple implementation, enough for self-produced + common third-party skills).
 *  Return values are a closed set; unparseable → undefined (frontmatter details never fail the whole import). */
function parseFrontmatter(content: string): { name?: string; description?: string; bodyStart: number; hasFrontmatter: boolean } {
  if (!content.startsWith('---')) return { bodyStart: 0, hasFrontmatter: false };
  const firstNl = content.indexOf('\n', 3);
  if (firstNl === -1) return { bodyStart: 0, hasFrontmatter: false };
  const close = content.indexOf('\n---', firstNl + 1);
  if (close === -1) return { bodyStart: 0, hasFrontmatter: false };
  const block = content.slice(3, close);
  const bodyStart = close + 4;
  const out: { name?: string; description?: string } = {};
  for (const line of block.split('\n')) {
    const m = /^\s*(name|description)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] as 'name' | 'description';
    let value = (m[2] ?? '').trim();
    if (value.startsWith('>') || value.startsWith('|')) continue; // folded/block scalar, not parsed
    if (value.length >= 2 && value[0] === '"' && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
    } else if (value.length >= 2 && value[0] === "'" && value.endsWith("'")) {
      value = value.slice(1, -1).replace(/''/g, "'").trim();
    }
    if (!value) continue;
    if (out[key] === undefined) out[key] = value;
  }
  return { ...out, bodyStart, hasFrontmatter: true };
}

/**
 * Pure parsing: reads only the repoDir directory, no network. Returns the parse result; throws Error when SKILL.md is missing/too large.
 *  Recursively collects the whole tree: excludes .git/node_modules/hidden files/symlinks; stops and records skipped when the file count or total bytes hit the cap.
 */
export async function parseSkillRepo(repoDir: string, repoDisplayName: string): Promise<ParsedSkillImport> {
  const mdPath = path.join(repoDir, 'SKILL.md');
  let mdStat;
  try { mdStat = await fs.stat(mdPath); } catch { throw new Error('仓库根目录没有 SKILL.md（不是可导入的 skill 仓库）'); }
  if (mdStat.size > SKILL_MD_MAX_BYTES) throw new Error(`SKILL.md 超过 ${SKILL_MD_MAX_BYTES / 1000}KB 上限`);
  const raw = await fs.readFile(mdPath, 'utf8');
  const fm = parseFrontmatter(raw);
  const body = (fm.hasFrontmatter ? raw.slice(fm.bodyStart).replace(/^\n+/, '') : raw).slice(0, SKILL_MD_MAX_BYTES);

  let name: string | undefined;
  if (fm.name) {
    const n = fm.name.trim();
    name = /^[a-z0-9-]+$/.test(n) && n.length <= 64 && !n.startsWith('-') && !n.endsWith('-') && !n.includes('--') ? n : undefined;
  }
  let nameKind: ParsedSkillImport['nameKind'];
  if (name) nameKind = 'frontmatter';
  else {
    const slug = sanitizeSlug(repoDisplayName.replace(/\.git$/, ''));
    if (!slug) throw new Error(`无法从仓库名推导出合法 slug（${repoDisplayName}），请用 name= 显式指定安装名`);
    name = slug;
    nameKind = 'sanitized';
  }
  const description = (fm.description ?? `从 GitHub 导入：${repoDisplayName}`).trim().slice(0, MAX_DESCRIPTION_CHARS);

  const files: SkillImportFile[] = [];
  const skipped: SkillImportSkipped[] = [];
  let totalBytes = 0;
  const walk = async (absDir: string, relDir: string, depth: number): Promise<void> => {
    if (files.length >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) return;
    if (depth > MAX_DEPTH) { skipped.push({ path: relDir || '.', reason: `目录层级超过 ${MAX_DEPTH}` }); return; }
    let entries;
    try { entries = await fs.readdir(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const childAbs = path.join(absDir, e.name);
      const childRel = relDir ? `${relDir}/${e.name}` : e.name;
      // Symlinks don't enter the tree: pointing outside is an escape surface; pointing inside would give the file tree and actual reads two divergent views.
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        await walk(childAbs, childRel, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      // Paths pass the guard before reading: the repo is a GitHub-whitelisted source, but every segment is still verified, ruling out .. segments/hidden segments.
      if (!resolveInSkill(repoDir, childRel)) { skipped.push({ path: childRel, reason: '路径非法' }); continue; }
      let st;
      try { st = await fs.stat(childAbs); } catch { continue; }
      if (st.size > FILE_MAX_BYTES) { skipped.push({ path: childRel, reason: `超过 ${FILE_MAX_BYTES / 1_000_000}MB 单文件上限` }); continue; }
      if (files.length >= MAX_FILES) { skipped.push({ path: childRel, reason: `文件数超过 ${MAX_FILES} 上限` }); return; }
      if (totalBytes + st.size > MAX_TOTAL_BYTES) { skipped.push({ path: childRel, reason: `总体积超过 ${MAX_TOTAL_BYTES / 1_000_000}MB 上限` }); return; }
      files.push({ path: childRel, content: await fs.readFile(childAbs, 'utf8'), size: st.size });
      totalBytes += st.size;
    }
  };
  await walk(repoDir, '', 0);

  return { name, description, body, files, skipped, nameKind };
}

/** git clone --depth 1 into a temp dir; returns the tmp dir path (the caller cleans up in finally). Throws Error on timeout/failure. */
export async function cloneSkillRepo(cloneUrl: string, branch: string | null): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-skill-'));
  const args = ['clone', '--depth', '1', '--single-branch'];
  if (branch) args.push('--branch', branch);
  args.push('--', cloneUrl, tmp);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    const timer = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already exited */ } }
      reject(new Error('git clone 超时（60s）'));
    }, CLONE_TIMEOUT_MS);
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`git 启动失败: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`git clone 失败（exit ${code}）${err ? ': ' + err.trim().slice(0, 300) : ''}`));
    });
  });
  return tmp;
}

export interface ImportResult {
  name: string;
  description: string;
  fileCount: number;
  totalBytes: number;
  /** First few file paths, for preview (no content, to avoid blowing up the model context). */
  files: Array<{ path: string; size: number }>;
  skipped: SkillImportSkipped[];
  nameKind: ParsedSkillImport['nameKind'];
  created?: boolean;
}

const PREVIEW_FILE_LIMIT = 30;

/** Orchestration: validate → clone → parse → (preview | persist). install=false or omitted = preview (no disk writes). */
export async function importSkillFromGithub(
  url: string,
  opts: { install?: boolean; name?: string; repoDisplayName?: string } = {},
): Promise<ImportResult> {
  const parsed = parseSkillUrl(url);
  if (!parsed) {
    throw new Error(`URL 非法：必须是 https://github.com/<owner>/<repo>（可带 /tree/<ref>；其他 host/协议一律拒绝）`);
  }
  const display = opts.repoDisplayName ?? parsed.cloneUrl.split('/').pop()!.replace(/\.git$/, '');
  const tmp = await cloneSkillRepo(parsed.cloneUrl, parsed.branch);
  try {
    const parsedSkill = await parseSkillRepo(tmp, display);
    const finalName = opts.name !== undefined ? opts.name.trim() : parsedSkill.name;
    const result: ImportResult = {
      name: finalName,
      description: parsedSkill.description,
      fileCount: parsedSkill.files.length,
      totalBytes: parsedSkill.files.reduce((n, f) => n + f.size, 0),
      files: parsedSkill.files.slice(0, PREVIEW_FILE_LIMIT).map(({ path: p, size }) => ({ path: p, size })),
      skipped: parsedSkill.skipped,
      nameKind: opts.name !== undefined ? 'sanitized' : parsedSkill.nameKind,
    };
    if (opts.install) {
      const dir = skillDirOf(finalName);
      await fs.mkdir(dir, { recursive: true });
      try {
        // Create all subdirectories before writing files one by one: resolveInSkill's requireParentExisting rejects newly created parent directories,
        // while import is the only place allowed to create directories (the source is the GitHub whitelist, not paths typed by a person in the settings page).
        for (const f of parsedSkill.files) {
          const i = f.path.lastIndexOf('/');
          if (i > 0) await fs.mkdir(path.join(dir, f.path.slice(0, i)), { recursive: true });
        }
        for (const f of parsedSkill.files) {
          const abs = resolveInSkill(dir, f.path);
          if (!abs) throw new Error(`导入路径非法: ${f.path}`);
          writeSkillFileAtomic(abs, f.content);
        }
        await registerSkill(finalName, parsedSkill.description);
      } catch (e) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        throw e;
      }
      result.created = true;
    }
    return result;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}