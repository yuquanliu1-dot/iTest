#!/usr/bin/env node
/**
 * 一次性种子：把 Claude 官方 skill-creator 技能落库为全局默认 skill。
 *
 * 背景（2026-10-18 决策）：
 *  - 用户拍板「仅本次一次落库」——不做代码级默认技能机制，发布 prod228 时插一次 DB 即可，
 *    后续各环境独立按需导入（走 import_skill 或本脚本）。
 *  - 来源：anthropics/skills 仓库 skills/skill-creator（Apache-2.0）。
 *  - 保真度：本脚本与 import_skill 同源——扁平化 SKILL.md(剥 frontmatter) + scripts/*.py 落库，
 *    丢弃 agents/ references/ eval-viewer/ assets/ 等非脚本资源（skill-creator 的 python 脚本
 *    以 `from scripts.xxx import` 包式引用这些资源，扁平安装后大概率跑不起来——这是已知损失，
 *    read_skill 仍可读 SKILL.md 正文。要保持完整请走 GitHub 原仓库）。
 *
 * 幂等：assistant_skills.name 唯一，ON CONFLICT 忽略已存在；重复执行安全。
 *
 * 用法（发布时在 api 容器内）:
 *   node /repo/apps/api/scripts/seed-skill-creator.mjs
 * 本地：
 *   DATABASE_URL=... node seed-skill-creator.mjs
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const CONTENT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'skill-creator-content');

/** 与 skillsStore.isSafeScriptFilename 同源的守卫（扁平安装只接受安全文件名）。 */
function isSafeScriptFilename(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.startsWith('.');
}

/** 剥 SKILL.md frontmatter（与 skillImport.parseFrontmatter 同源，够覆盖自产 + 常见第三方）。 */
function parseMarkdown(raw) {
  if (!raw.startsWith('---')) return { fm: {}, body: raw };
  const firstNl = raw.indexOf('\n', 3);
  if (firstNl === -1) return { fm: {}, body: raw };
  const close = raw.indexOf('\n---', firstNl + 1);
  if (close === -1) return { fm: {}, body: raw };
  const block = raw.slice(3, close);
  const fm = {};
  for (const line of block.split('\n')) {
    const m = /^\s*(name|description)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = (m[2] ?? '').trim();
    if (value.length >= 2 && value[0] === '"' && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
    }
    if (value && fm[key] === undefined) fm[key] = value;
  }
  return { fm, body: raw.slice(close + 4).replace(/^\n+/, '') };
}

async function main() {
  const md = await readFile(join(CONTENT_DIR, 'SKILL.md'), 'utf8');
  const { fm, body } = parseMarkdown(md);
  const name = (fm.name ?? 'skill-creator').trim();
  const description = (fm.description ?? '从 GitHub 导入：skill-creator').trim().slice(0, 500);
  if (!/^[a-z0-9-]+$/.test(name) || name.length > 64 || name.startsWith('-') || name.endsWith('-') || name.includes('--')) {
    throw new Error(`frontmatter name 非法: ${name}`);
  }
  if (!body.trim()) throw new Error('SKILL.md 正文为空');

  // scripts/*.py：runtime 按 shebang/扩展名推断（python3）；非法文件名跳过。
  const scripts = [];
  const scriptsDir = join(CONTENT_DIR, 'scripts');
  const files = (await readdir(scriptsDir)).filter((f) => !f.startsWith('.'));
  for (const f of files.sort((a, b) => a.localeCompare(b))) {
    const fp = join(scriptsDir, f);
    const st = await stat(fp);
    if (!st.isFile() || !isSafeScriptFilename(f)) continue;
    const content = await readFile(fp, 'utf8');
    const runtime = /\.py$/i.test(f) ? 'python3' : /\.sh$/i.test(f) ? 'bash' : /\.(js|mjs|cjs)$/i.test(f) ? 'node' : null;
    if (runtime) scripts.push({ filename: f, runtime, content });
  }
  if (scripts.length === 0) throw new Error('没有可用脚本');

  const DATABASE_URL = process.env.DATABASE_URL;
  const client = DATABASE_URL
    ? new pg.Client({ connectionString: DATABASE_URL })
    : new pg.Client({ host: 'itest-pg', user: 'itest', password: 'itest', database: 'itest' });
  await client.connect();
  try {
    const r = await client.query(
      `INSERT INTO assistant_skills (id, name, description, body, scripts, enabled)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, true)
       ON CONFLICT (name) DO NOTHING RETURNING name`,
      [name, description, body, JSON.stringify(scripts)],
    );
    if (r.rows.length === 0) {
      console.log(`skill "${name}" 已存在，跳过（幂等）`);
    } else {
      console.log(`已落库 skill "${name}"（${scripts.length} 个脚本：${scripts.map((s) => s.filename).join(', ')}）`);
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('seeding failed:', e.message);
  process.exit(1);
});