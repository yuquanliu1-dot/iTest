/**
 * skill_import 共用层：从 GitHub 拉取 skill 仓库 → 校验 → 解析 → （预览 | 落库）。
 *
 * 安全设计：
 *  - SSRF 结构性规避：URL 解析后 host 必须精确 ∈ {github.com, www.github.com}，否则拒绝——
 *    不解析任何用户可控的宿主机名，DNS rebinding / 私网探测面直接不存在。
 *  - 拉取走 `git clone --depth 1`（spawn 数组参数，无 shell），branch/ref 经词法正则白名单
 *    （^[A-Za-z0-9._/-]+$ 且不以 - 开头），杜绝参数注入。
 *  - clone 到 mkdtemp 临时目录，finally 清理；超时 60s SIGKILL 进程组。
 *  - 解耦：parseSkillRepo 是纯函数（本地可单测，不碰网络）；fetch 层做薄。
 *
 * 仓库布局（2026-10-19 起为**整棵目录树原样落盘**）：
 *  - 根目录 SKILL.md（必需）→ 目录里的第一份文件；frontmatter 的 name/description 仍走 DB 元数据列
 *  - 其余文件递归全收：agents/ references/ assets/ eval-viewer/ scripts/ …（官方 skill-creator
 *    的 19 个文件正是这个形态，旧实现只收 scripts/ 下的平级文件，另外 4 个目录 9 个文件全丢）
 *  - 剔除 .git / node_modules / 隐藏文件 / 软链；单文件 >1MB 或总文件数 >200 → 记 skipped 后继续
 *  - runtime 不再存储也不再作为准入条件（执行时按 shebang 推断），故 .md/.html 一律能装
 *
 * name 取值次序：frontmatter name（须为合法 slug）→ 仓库短名 sanitize → 仍无效则报错请用户给 name= 覆盖。
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
  /** 相对技能根的完整文件树（posix 分隔），含 SKILL.md 本身。 */
  files: SkillImportFile[];
  skipped: SkillImportSkipped[];
  /** name 来源：frontmatter 命中 / 仓库名 sanitize / 用户 name 覆盖（install 侧）。 */
  nameKind: 'frontmatter' | 'sanitized';
}

/** URL → (cloneUrl, branch?)。非法 URL/非 github.com/路径结构不对 → null。
 *  host 白名单硬编码，端口缺省 443；userinfo/非 https/非 443 端口一律拒绝。 */
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

/** 把不可信名称 sanitize 成合法 slug：小写、非法字符→-、折叠连续 -、去首尾 -。空 → null。 */
export function sanitizeSlug(raw: string): string | null {
  const s = (raw || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  return s.length > 0 && s.length <= 64 ? s : null;
}

/** 解析 YAML-like frontmatter 的 name/description 标量（简单实现，够覆盖自产 + 常见第三方）。
 *  返回值闭区间，解析不出就 undefined（不因 frontmatter 细节 fail 整个导入）。 */
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
    if (value.startsWith('>') || value.startsWith('|')) continue; // 折叠/块标量，不解析
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
 * 纯解析：只读 repoDir 目录，不碰网络。返回解析结果；SKILL.md 缺失/过大抛 Error。
 *  递归收整棵树：剔除 .git/node_modules/隐藏文件/软链，文件数或总字节触顶即停并记 skipped。
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
      // 软链不进树：指向树外即逃逸面，指向树内也会让文件树与实际读取产生两套视图。
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        await walk(childAbs, childRel, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      // 路径先过守卫再读：仓库是 GitHub 白名单来源，但仍逐段验一遍，杜绝 .. 段/隐藏段。
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

/** git clone --depth 1 到临时目录；返回 tmp 目录路径（调用方负责 finally 清理）。超时/失败抛 Error。 */
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
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }
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
  /** 前若干个文件路径，给 preview 用（不吐正文，免得撑爆模型上下文）。 */
  files: Array<{ path: string; size: number }>;
  skipped: SkillImportSkipped[];
  nameKind: ParsedSkillImport['nameKind'];
  created?: boolean;
}

const PREVIEW_FILE_LIMIT = 30;

/** 编排：validate → clone → parse → （预览 | 落盘）。install=false 或缺省 = 预览（不写盘）。 */
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
        // 先建全部子目录再逐文件写：resolveInSkill 的 requireParentExisting 会拒新建父目录，
        // 而导入是唯一允许建目录的地方（来源是 GitHub 白名单，不是人在设置页敲的路径）。
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