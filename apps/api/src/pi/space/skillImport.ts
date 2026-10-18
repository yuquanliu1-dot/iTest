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
 * 仓库布局（与物化目录同源）：
 *  - 根目录 SKILL.md（必需）→ body（frontmatter 被剥掉；name/description 走列）
 *  - scripts/ 子目录内文件，或（无 scripts/ 时）根目录脚本文件 → scripts[]
 *  - 脚本 runtime 推断：shebang 命中（node|python3|bash|sh）优先，回退扩展名；
 *    两者都判不出（未知 runtime / 无扩展名无 shebang）→ skip（不默认 node，外部不可信输入从严）。
 *  - 非法文件名 / 未知 runtime / 超大（脚本 >1MB）→ skip 并记录原因，不影响其余可装项；
 *    preview 会把 skipped 呈现给用户，install 前人工可见。
 *
 * name 取值次序：frontmatter name（须为合法 slug）→ 仓库短名 sanitize → 仍无效则报错请用户给 name= 覆盖。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createSkill } from './skillsService.js';
import { isSafeScriptFilename, type ScriptRuntime } from './skillsStore.js';

const SKILL_MD_MAX_BYTES = 200_000;
const SCRIPT_MAX_BYTES = 1_000_000;
const MAX_SCRIPTS = 50;
const MAX_DESCRIPTION_CHARS = 500;
const CLONE_TIMEOUT_MS = 60_000;

const RUNTIME_RE = /\b(?:env )?(node|python3|bash|sh)\b/;

export interface SkillImportScript { filename: string; runtime: ScriptRuntime; content: string; size: number }
export interface SkillImportSkipped { filename: string; reason: string }

export interface ParsedSkillImport {
  name: string;
  description: string;
  body: string;
  scripts: SkillImportScript[];
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

/** 逐文件解析脚本：返回 (runtime | null, content)。shebang 优先生效；无 shebang 回退扩展名；
 *  两者皆不可判（未知 runtime / 无扩展名无 shebang）→ null（外部不可信输入，不默认 node）。 */
async function inspectScriptFile(fp: string): Promise<{ runtime: ScriptRuntime | null; content: string }> {
  const head = Buffer.alloc(512);
  const fh = await fs.open(fp, 'r');
  try { await fh.read(head, 0, 512, 0); } finally { await fh.close(); }
  const headStr = head.toString('utf8');
  const firstLine = headStr.split('\n')[0] ?? '';
  let runtime: ScriptRuntime | null = null;
  const m = RUNTIME_RE.exec(firstLine);
  if (m) {
    runtime = m[1] as ScriptRuntime;
  } else if (!firstLine.trimStart().startsWith('#!')) {
    const lower = fp.toLowerCase();
    if (/\.py$/i.test(lower)) runtime = 'python3';
    else if (/\.sh$/i.test(lower)) runtime = 'bash';
    else if (/\.(js|mjs|cjs)$/i.test(lower)) runtime = 'node';
  }
  const content = (await fs.readFile(fp, 'utf8')).slice(0, SCRIPT_MAX_BYTES);
  return { runtime, content };
}

/**
 * 纯解析：只读 repoDir 目录，不碰网络。返回解析结果；SKILL.md 缺失/过大抛 Error。
 *  scripts 布局：优先 <dir>/scripts/，缺失时取根目录脚本文件（跳过 SKILL.md 与隐藏文件）。
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

  const scriptsDir = path.join(repoDir, 'scripts');
  let scriptFiles: string[];
  let dirKind: 'scripts-dir' | 'root';
  try {
    const st = await fs.stat(scriptsDir);
    if (!st.isDirectory()) throw new Error();
    scriptFiles = (await fs.readdir(scriptsDir)).filter((f) => !f.startsWith('.')).slice(0, MAX_SCRIPTS);
    dirKind = 'scripts-dir';
  } catch {
    scriptFiles = (await fs.readdir(repoDir)).filter((f) => !f.startsWith('.') && f !== 'SKILL.md').slice(0, MAX_SCRIPTS);
    dirKind = 'root';
  }

  const scripts: SkillImportScript[] = [];
  const skipped: SkillImportSkipped[] = [];
  for (const f of scriptFiles.sort((a, b) => a.localeCompare(b))) {
    const fp = path.join(dirKind === 'scripts-dir' ? scriptsDir : repoDir, f);
    let st;
    try { st = await fs.stat(fp); } catch { continue; }
    if (!st.isFile()) { skipped.push({ filename: f, reason: '非文件' }); continue; }
    if (st.size > SCRIPT_MAX_BYTES) { skipped.push({ filename: f, reason: `超过 1MB` }); continue; }
    if (!isSafeScriptFilename(f)) { skipped.push({ filename: f, reason: '文件名非法' }); continue; }
    const { runtime, content } = await inspectScriptFile(fp);
    if (!runtime) { skipped.push({ filename: f, reason: 'runtime 未知（shebang/扩展名无法识别）' }); continue; }
    scripts.push({ filename: f, runtime, content, size: st.size });
  }

  return { name, description, body, scripts, skipped, nameKind };
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
  bodySize: number;
  scripts: Array<{ filename: string; runtime: string; size: number }>;
  skipped: SkillImportSkipped[];
  nameKind: ParsedSkillImport['nameKind'];
  created?: boolean;
}

/** 编排：validate → clone → parse → （预览 | 落库）。install=false 或缺省 = 预览（不写库）。
 *  install=true 时 name 为空则用解析名；nameKind 覆盖安装名（仍走 assertSkillName 校验）。 */
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
    const scripts = parsedSkill.scripts.map((s) => ({ filename: s.filename, runtime: s.runtime, size: s.size }));
    const result: ImportResult = {
      name: finalName,
      description: parsedSkill.description,
      bodySize: parsedSkill.body.length,
      scripts,
      skipped: parsedSkill.skipped,
      nameKind: opts.name !== undefined ? 'sanitized' : parsedSkill.nameKind,
    };
    if (opts.install) {
      await createSkill({
        name: finalName,
        description: parsedSkill.description,
        body: parsedSkill.body,
        scripts: parsedSkill.scripts.map(({ filename, runtime, content }) => ({ filename, runtime, content })),
      });
      result.created = true;
    }
    return result;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}