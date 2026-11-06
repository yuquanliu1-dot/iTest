// 一次性工具：从 reqDesign.ts 提取 REQ_DESIGN_METHOD / CASE_AUTHORING_FLOW_ZH/EN 模板字面量，生成 prod228 手动 UPDATE SQL。
// 用法：node scripts/gen-guide-update-sql.mjs [/tmp/guide_update_0001_0002_0003.sql]
import { readFileSync, writeFileSync } from 'node:fs';

const out = process.argv[2] ?? '/tmp/guide_update_0001_0002_0003.sql';
const ts = readFileSync(new URL('../src/pi/space/reqDesign.ts', import.meta.url), 'utf8');

function extract(name) {
  const m = new RegExp(`export const ${name} = \`([\\s\\S]*?)\`;`, 'm').exec(ts);
  if (!m) throw new Error(`template literal ${name} not found`);
  return m[1];
}

const esc = (s) => s.replace(/'/g, "''");
const req = extract('REQ_DESIGN_METHOD');
const zh = extract('CASE_AUTHORING_FLOW_ZH');
const en = extract('CASE_AUTHORING_FLOW_EN');

const sql =
  `-- prod228 手动 UPDATE：assistant_guides seed 是 ON CONFLICT DO NOTHING，改常量不会自动更新已有行。\n` +
  `-- 容器内执行：psql -U itest -d itest -f guide_update_0001_0002_0003.sql\n` +
  `UPDATE assistant_guides SET body = '${esc(req)}' WHERE id = '00000000-0000-0000-0000-000000000001';\n` +
  `UPDATE assistant_guides SET body = '${esc(zh)}' WHERE id = '00000000-0000-0000-0000-000000000002';\n` +
  `UPDATE assistant_guides SET body = '${esc(en)}' WHERE id = '00000000-0000-0000-0000-000000000003';\n`;

writeFileSync(out, sql);
console.log(`SQL written → ${out} (req ${req.length} bytes, zh ${zh.length} bytes, en ${en.length} bytes)`);
