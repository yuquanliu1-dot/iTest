#!/usr/bin/env node
/**
 * 一次性种子：把 Claude 官方 skill-creator 技能落盘为全局默认 skill。
 *
 * 背景（2026-10-18 决策，2026-10-19 随存储翻转重写）：
 *  - 用户拍板「仅本次一次落库」——不做代码级默认技能机制，发布 prod228 时执行一次即可，
 *    后续各环境独立按需导入（走 import_skill 或本脚本）。
 *  - 来源：anthropics/skills 仓库 skills/skill-creator（Apache-2.0），完整目录树 18 文件 / 248KB。
 *  - 存储翻转后技能内容【以文件系统为真源】，DB 只留 name/description/enabled。
 *    故本脚本 = 复制整棵目录树到 $PI_DATA_DIR/skills/skill-creator + upsert 元数据行。
 *    （2026-10-19 前是「扁平化落库」：SKILL.md 剥 frontmatter 存 body 列、scripts/ 下
 *    平级 .py 存 scripts 列，并丢弃 agents/ references/ eval-viewer/ assets/。
 *    那正是官方脚本写 `from scripts.xxx import` 却 ModuleNotFoundError 的根因——
 *    扁平安装连 scripts/ 目录都不保留，谈不上是包。）
 *
 * 幂等 + 自愈：
 *  - 磁盘目录已在且有 SKILL.md → 不动它（用户可能改过内容，每次发版覆盖会丢编辑）。
 *  - 目录缺失/空 → 重新铺目录树（修「DB 有行、盘上没目录」的空壳态）。
 *  - DB 行按 ON CONFLICT DO NOTHING 补；旧 schema(body/scripts NOT NULL)下不硬插，
 *    改为告警退出 0——发版流程里 drizzle-kit push 先于本脚本跑，正常不会命中。
 *
 * 用法（发布时在 api 容器内）:
 *   node /repo/apps/api/scripts/seed-skill-creator.mjs
 * 本地：
 *   DATABASE_URL=... PI_DATA_DIR=/tmp/pidata node seed-skill-creator.mjs
 */
import { readFile, cp, rm, mkdir, readdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const CONTENT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'skill-creator-content');
const NAME = 'skill-creator';

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

/** 递归数文件数（只发计数，不把 248KB 打进日志）。 */
async function countFiles(dir) {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += await countFiles(join(dir, e.name));
    else if (e.isFile()) n += 1;
  }
  return n;
}

async function main() {
  const md = await readFile(join(CONTENT_DIR, 'SKILL.md'), 'utf8');
  const fm = parseFrontmatter(md);
  const description = (fm.description ?? '从 GitHub 导入：skill-creator').trim().slice(0, 500);

  const root = process.env.PI_DATA_DIR
    ? join(process.env.PI_DATA_DIR, 'skills')
    : '/repo/apps/api/.data/skills';
  const target = join(root, NAME);

  // 目录是发布物，但要尊重用户编辑：只有缺失/空才铺。
  // 早先版本是无条件 rm+cp，导致每次发版都把用户在设置页里改过的 SKILL.md 冲掉。
  let seeded = false;
  try {
    await access(join(target, 'SKILL.md'));
  } catch {
    await rm(target, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    await cp(CONTENT_DIR, target, { recursive: true });
    seeded = true;
  }

  const client = process.env.DATABASE_URL
    ? new pg.Client({ connectionString: process.env.DATABASE_URL })
    : new pg.Client({ host: 'itest-pg', user: 'itest', password: 'itest', database: 'itest' });
  await client.connect();
  try {
    const fileCount = await countFiles(target);
    // 注意列集：body/scripts 已随存储翻转 drop，写进去会直接报 undefined_column。
    // 反向也真实存在过：库还是旧 schema 时 body/scripts 是 NOT NULL，
    // 而 NOT NULL 约束在 ON CONFLICT 冲突仲裁【之前】求值——即使这行已存在、
    // 冲突会被 DO NOTHING 吞掉，INSERT 仍先因 body 为 NULL 而失败。
    // 那种情况下技能目录已经落好了，DB 行也已存在，没有可补的，告警即可，不能让发版红掉。
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
