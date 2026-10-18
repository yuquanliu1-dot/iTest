#!/usr/bin/env node
/**
 * 存储翻转的一次性前置：把仍只存在于 DB body/scripts 列的技能内容导出为目录树。
 *
 * 【必须在新代码上线之前、且旧代码仍能跑时执行】——
 * 一旦 assistant_skills 的 body/scripts 两列被 drizzle-kit push drop，
 * 内容就只能从停转的旧代码实例里捞，运行中的系统再也无法恢复。
 * 落地顺序：跑本脚本 → 确认磁盘树完整 → 才允许发新版镜像。
 *
 * 导出后的目录尚未登记/更新 DB 元数据：
 *  - DB 里已有的行会被更新 name 保持一致（不插新行，避免与 seed 抢）；
 *  - 目录里存在而 DB 无行的「孤儿技能」不在本脚本职责内——它没有 description 可用，
 *    需要人/设置页补齐元数据后才入 catalog。脚本会打印出来供人工确认。
 *
 * 用法：
 *   DATABASE_URL=... PI_DATA_DIR=/tmp/pidata node export-skills-to-disk.mjs
 *   （无 PI_DATA_DIR 时默认 /repo/apps/api/.data/skills，即容器内路径）
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
    // 本脚本跑在旧 schema 上；新代码上线后这张表已无 body/scripts 两列，届时本脚本会直接报错——
    // 这正是「必须在发版前跑」的信号，不是 bug。
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
      } catch { /* 不存在则导出 */ }

      await mkdir(join(dir, 'scripts'), { recursive: true });
      // SKILL.md 回填 frontmatter：磁盘正文是真身，前言只是给 loader/列表用的索引。
      await writeFile(
        join(dir, 'SKILL.md'),
        `---\nname: ${JSON.stringify(r.name)}\ndescription: ${JSON.stringify(r.description)}\n---\n\n${r.body ?? ''}`,
        'utf8',
      );
      const scripts = Array.isArray(r.scripts) ? r.scripts : [];
      for (const s of scripts) {
        // 旧 schema 里 scripts[].filename 是【平级】文件名（无路径）。这里仍按平级写，
        // 语义与旧实现一致：历史技能的脚本本就不构成包，from scripts.x import 报不出来是已知的。
        await writeFile(join(dir, 'scripts', String(s.filename)), s.content, 'utf8');
      }
      exported.push(r.name);
      console.log(`已导出 ${r.name}（${scripts.length} 个脚本 → ${dir}）`);
    }
  } finally {
    await client.end();
  }

  // 孤儿 = 磁盘有目录但 DB 无行（无 description，无法入 catalog）。
  // 必须拿 DB 全量名字比，而不是「本次导出的」——后者会让重跑时把已导出的技能误报成孤儿。
  let onDisk = [];
  try { onDisk = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* root 尚未建立 */ }
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
