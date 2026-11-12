#!/usr/bin/env node
/**
 * One-time seed: lay Claude's official skill-creator skill on disk as the global default skill.
 *
 * Background (decision 2026-10-18, rewritten 2026-10-19 along with the storage flip):
 *  - The user decided "seed to DB once, this time only" -- no code-level default-skill mechanism; just execute once when releasing prod228,
 *    after which each environment imports independently on demand (via import_skill or this script).
 *  - Source: anthropics/skills repo, skills/skill-creator (Apache-2.0), full directory tree of 18 files / 248KB.
 *  - After the storage flip, skill content [has the filesystem as its source of truth]; the DB keeps only name/description/enabled.
 *    So this script = copy the whole directory tree to $PI_DATA_DIR/skills/skill-creator + upsert the metadata row.
 *    (Before 2026-10-19 it was "flattened into the DB": SKILL.md stripped of frontmatter into the body column,
 *    flat .py files under scripts/ into the scripts column, discarding agents/ references/ eval-viewer/ assets/.
 *    That was the root cause of the official script's `from scripts.xxx import` raising ModuleNotFoundError --
 *    a flat install doesn't even keep the scripts/ directory, so it can hardly be called a package.)
 *
 * Idempotent + self-healing:
 *  - If the on-disk directory exists with SKILL.md -> leave it alone (the user may have edited content; overwriting at every release loses edits).
 *  - If the directory is missing/empty -> re-lay the directory tree (fixes the hollow state of "row in DB, no directory on disk").
 *  - DB rows are filled via ON CONFLICT DO NOTHING; on the old schema (body/scripts NOT NULL) we don't force-insert,
 *    instead warning and exiting 0 -- in the release flow drizzle-kit push runs before this script, so it normally doesn't trigger.
 *
 * Usage (inside the api container at release time):
 *   node /repo/apps/api/scripts/seed-skill-creator.mjs
 * Locally:
 *   DATABASE_URL=... PI_DATA_DIR=/tmp/pidata node seed-skill-creator.mjs
 */
import { readFile, cp, rm, mkdir, readdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const CONTENT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'skill-creator-content');
const NAME = 'skill-creator';

/** Minimal frontmatter value extraction with the same semantics as skillImport.parseFrontmatter (enough to cover self-produced + common third-party skills). */
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

/** Recursively count files (emit only the count; don't dump 248KB into the log). */
async function countFiles(dir) {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += await countFiles(join(dir, e.name));
    else if (e.isFile()) n += 1;
  }
  return n;
}

/**
 * Recursively remove AppleDouble leftovers (`._xxx`).
 *
 * macOS writes extended attributes (com.apple.provenance etc.) into tar's pax headers; although
 * server-side GNU tar ignores those headers, resource-fork content still lands as `._xxx` files -- in practice
 * skill-creator's 18 files became 41 on the remote side. These files are meaningless to skill content, yet they:
 *   1) get listed as real files in read_skill's file tree (the model sees noise like ._SKILL.md);
 *   2) introduce ghost entries into run_skill_script's script list.
 * Hence clean before laying the directory, and clean once more after (in case the old directory was already polluted).
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
  const description = (fm.description ?? '从 GitHub 导入：skill-creator').trim().slice(0, 500);

  const root = process.env.PI_DATA_DIR
    ? join(process.env.PI_DATA_DIR, 'skills')
    : '/repo/apps/api/.data/skills';
  const target = join(root, NAME);

  // The directory is a release artifact, but respect user edits: only seed when missing/empty.
  // An earlier version did unconditional rm+cp, wiping the SKILL.md the user had edited on the settings page at every release.
  let seeded = false;
  try {
    await access(join(target, 'SKILL.md'));
  } catch {
    await rm(target, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    // The source directory may also be polluted (the image was built from an earlier tarball); clean before laying.
    await pruneAppleDouble(CONTENT_DIR);
    await cp(CONTENT_DIR, target, { recursive: true });
    seeded = true;
  }

  // Existing directories get cleaned too: AppleDouble is left by historical tarballs and is not a user edit;
  // removing it loses no real content (real files are never touched).
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
    // Note the column set: body/scripts were dropped along with the storage flip; writing them would immediately raise undefined_column.
    // The reverse also really happened: while the DB was still on the old schema, body/scripts were NOT NULL,
    // and the NOT NULL constraint is evaluated [before] ON CONFLICT arbitration -- even if this row already exists and
    // the conflict would be swallowed by DO NOTHING, the INSERT still fails first because body is NULL.
    // In that case the skill directory is already laid down and the DB row exists; there is nothing to backfill -- just warn, never turn the release red.
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
