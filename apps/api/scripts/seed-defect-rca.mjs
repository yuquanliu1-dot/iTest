#!/usr/bin/env node
/** defect-rca skill 种子：落盘目录树 + upsert 元数据；缺失才铺，改文案须手动重铺（删目录或手动 cp）。 */
import { readFile, cp, rm, mkdir, readdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const CONTENT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'defect-rca-content');
const NAME = 'defect-rca';

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

/**
 * 递归删除 AppleDouble 残骸（`._xxx`）。
 *
 * macOS 会把扩展属性（com.apple.provenance 等）写进 tar 的 pax 头，服务器侧
 * GNU tar 虽忽略这些头，资源叉内容仍会落成 `._xxx` 文件——实测 skill-creator
 * 18 个文件在远端变成 41 个。这些文件对技能内容毫无意义，却会：
 *   1) 被 read_skill 的文件树当成真实文件列出来（模型看到 ._SKILL.md 这种噪声）；
 *   2) 让 run_skill_script 的脚本清单出现幽灵条目。
 * 故铺目录前先清干净，铺完再清一次（防旧目录已被污染）。
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
  const description = (fm.description ?? 'defect-rca skill').trim().slice(0, 500);

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
    // 源目录也可能是被污染的（镜像由更早的 tarball 构建），铺之前先清。
    await pruneAppleDouble(CONTENT_DIR);
    await cp(CONTENT_DIR, target, { recursive: true });
    seeded = true;
  }

  // 已有目录同样要清：AppleDouble 是历史 tarball 留下的，不属于用户编辑，
  // 清掉不丢任何真实内容（真实文件一律不动）。
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
