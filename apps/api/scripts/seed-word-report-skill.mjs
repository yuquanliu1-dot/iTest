#!/usr/bin/env node
/** word-test-report skill 种子：落盘目录树 + upsert 元数据；缺失才铺，改文案须手动重铺（删目录或手动 cp）。
 *  结构与 seed-defect-rca.mjs 一致（存储翻转后内容以文件系统为真源，DB 只留元数据）。 */
import { readFile, cp, rm, mkdir, readdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const CONTENT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'word-test-report-content');
const NAME = 'word-test-report';

/** 与 skillImport.parseFrontmatter 同源的极简 frontmatter 取值（够覆盖自产 + 常见第三方）。 */
function parseFrontmatter(raw) {
  const m = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = /^\s*(name|description)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.length >= 2 && v[0] === '"' && v.endsWith('"')) v = v.slice(1, -1);
    if (v.length >= 2 && v[0] === "'" && v.endsWith("'")) v = v.slice(1, -1);
    if (v) out[kv[1]] = v;
  }
  return out;
}

/** 递归数文件数（只发计数，不打内容）。 */
async function countFiles(dir) {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += await countFiles(join(dir, e.name));
    else if (e.isFile()) n += 1;
  }
  return n;
}

/**
 * 递归删除 AppleDouble 残骸（`._xxx`）。
 * macOS tar 会把扩展属性落成 `._xxx` 文件（实测 skill-creator 18 文件在远端变 41 个）：
 * 被 read_skill 文件树当真实文件列出、在 run_skill_script 脚本清单里出幽灵条目。
 * 铺目录前清源，铺完再清目标（真实文件一律不动）。
 */
async function pruneAppleDouble(dir) {
  let removed = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      removed += await pruneAppleDouble(p);
    } else if (e.name.startsWith('._')) {
      await rm(p, { force: true });
      removed += 1;
    }
  }
  return removed;
}

async function main() {
  const md = await readFile(join(CONTENT_DIR, 'SKILL.md'), 'utf8');
  const fm = parseFrontmatter(md);
  const description = (fm.description ?? 'word-test-report skill').trim().slice(0, 500);

  const root = process.env.PI_DATA_DIR
    ? join(process.env.PI_DATA_DIR, 'skills')
    : '/repo/apps/api/.data/skills';
  const target = join(root, NAME);

  // 目录是发布物，但尊重用户编辑：只有缺失/空才铺。
  let seeded = false;
  try {
    await access(join(target, 'SKILL.md'));
  } catch {
    await rm(target, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    await pruneAppleDouble(CONTENT_DIR);
    await cp(CONTENT_DIR, target, { recursive: true });
    seeded = true;
  }
  const pruned = await pruneAppleDouble(target);
  if (pruned > 0) {
    console.log(`已清理 ${pruned} 个 AppleDouble 残骸文件（${target}）`);
  }

  const client = process.env.DATABASE_URL
    ? new pg.Client({ connectionString: process.env.DATABASE_URL })
    : new pg.Client({ host: 'itest-pg', user: 'itest', password: 'itest', database: 'itest' });
  await client.connect();
  try {
    const fileCount = await countFiles(target);
    let inserted = false;
    let r;
    try {
      r = await client.query(
        `INSERT INTO assistant_skills (id, name, description, enabled)
         VALUES (gen_random_uuid(), $1, $2, true)
         ON CONFLICT (name) DO NOTHING RETURNING name`,
        [NAME, description],
      );
      inserted = r.rows.length > 0;
    } catch (e) {
      if (!/body|scripts|column/.test(e.message)) throw e;
      const { rows } = await client.query('SELECT name FROM assistant_skills WHERE name = $1', [NAME]);
      if (!rows[0]) throw e;
      console.warn(
        `WARN: assistant_skills 仍是旧 schema（含 body/scripts），无法补元数据行；` +
          `「${NAME}」DB 行已存在、技能目录已落盘（${fileCount} 文件），可正常使用。` +
          `待 drizzle-kit push 迁移后重跑本脚本即可。`,
      );
      return;
    }
    console.log(
      seeded
        ? `已落盘 skill "${NAME}"（${fileCount} 文件 → ${target}）${inserted ? '，并补齐 DB 元数据行' : '；DB 行已存在（幂等）'}`
        : `技能目录已存在，未覆盖（${fileCount} 文件 → ${target}）${inserted ? '，补齐 DB 元数据行' : ''}`,
    );
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('seeding failed:', e.message);
  process.exit(1);
});
