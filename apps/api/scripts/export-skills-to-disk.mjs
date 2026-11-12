#!/usr/bin/env node
/**
 * One-time prerequisite of the storage flip: export skill content that still lives only in the DB body/scripts columns into a directory tree.
 *
 * [Must run BEFORE the new code ships, while the old code can still run] --
 * once the assistant_skills body/scripts columns are dropped by drizzle-kit push,
 * the content can only be recovered from a stopped old-code instance; the running system can never restore it.
 * Rollout order: run this script -> confirm the on-disk tree is complete -> only then may the new image be released.
 *
 * The exported directories are not yet registered/updated in DB metadata:
 *  - rows already in the DB get their name updated for consistency (no new rows inserted, to avoid racing with seed);
 *  - "orphan skills" present on disk but absent in the DB are out of scope for this script -- they have no description available,
 *    and need a human / the settings page to fill metadata before entering the catalog. The script prints them for manual review.
 *
 * Usage:
 *   DATABASE_URL=... PI_DATA_DIR=/tmp/pidata node export-skills-to-disk.mjs
 *   (without PI_DATA_DIR the default is /repo/apps/api/.data/skills, the in-container path)
 */
import { mkdir, writeFile, access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const root = process.env.PI_DATA_DIR
  ? join(process.env.PI_DATA_DIR, 'skills')
  : '/repo/apps/api/.data/skills';

async function main() {
  const client = process.env.DATABASE_URL
    ? new pg.Client({ connectionString: process.env.DATABASE_URL })
    : new pg.Client({ host: 'itest-pg', user: 'itest', password: 'itest', database: 'itest' });
  await client.connect();
  const exported = [];
  const dbNames = [];
  try {
    // This script runs on the old schema; after the new code ships this table no longer has the body/scripts columns,
    // at which point this script will fail outright --
    // that is exactly the signal of "must run before the release", not a bug.
    const { rows } = await client.query(
      `SELECT name, description, body, scripts FROM assistant_skills ORDER BY name`,
    );
    dbNames.push(...rows.map((r) => r.name));
    if (rows.length === 0) console.log('DB 无技能行，无需导出');
    for (const r of rows) {
      const dir = join(root, r.name);
      try {
        await access(dir);
        console.log(`跳过 ${r.name}（目录已存在，不覆盖）`);
        continue;
      } catch { /* not present -> export */ }

      await mkdir(join(dir, 'scripts'), { recursive: true });
      // Backfill frontmatter into SKILL.md: the on-disk body is the source of truth; frontmatter is just the index for loader/listing.
      await writeFile(
        join(dir, 'SKILL.md'),
        `---\nname: ${JSON.stringify(r.name)}\ndescription: ${JSON.stringify(r.description)}\n---\n\n${r.body ?? ''}`,
        'utf8',
      );
      const scripts = Array.isArray(r.scripts) ? r.scripts : [];
      for (const s of scripts) {
        // In the old schema scripts[].filename is a flat file name (no path). We still write flat here,
        // matching the old implementation: historical skills' scripts never formed a package; `from scripts.x import` failing to resolve is a known issue.
        await writeFile(join(dir, 'scripts', String(s.filename)), s.content, 'utf8');
      }
      exported.push(r.name);
      console.log(`已导出 ${r.name}（${scripts.length} 个脚本 → ${dir}）`);
    }
  } finally {
    await client.end();
  }

  // Orphan = a directory on disk with no DB row (no description, cannot enter the catalog).
  // Must compare against the full set of DB names, not "the ones exported this run" -- the latter would misreport already-exported skills as orphans on re-run.
  let onDisk = [];
  try { onDisk = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* root not yet created */ }
  const orphans = onDisk.filter((n) => !dbNames.includes(n));
  console.log(`\n本次新导出 ${exported.length} 个（DB 共 ${dbNames.length} 个技能）→ ${root}`);
  if (orphans.length) {
    console.log('⚠️ 磁盘上另有目录但 DB 无对应行（无 description 入不了 catalog，需人工补元数据）：');
    for (const n of orphans) console.log(`  - ${n}`);
  } else {
    console.log('无孤儿目录（磁盘目录与 DB 行一一对应）');
  }
  console.log('核对无误后再发新版镜像（发版后 body/scripts 两列会被 drop）。');
}

main().catch((e) => {
  console.error('export failed:', e.message);
  process.exit(1);
});
