import { pool } from '../src/db/client.ts';

const r = await pool.query(`SELECT doc FROM ai_workspace_state WHERE requirement_id = $1`, ['2940bcf9-eabd-48ec-acec-239b49b4f19d']);
const d = r.rows[0]?.doc;
console.log('raw doc keys:', Object.keys(d ?? {}));
console.log('scenarios:', (d?.scenarios ?? []).length);
let total = 0;
for (const s of (d?.scenarios ?? [])) {
  console.log(`  - ${s.id} '${s.title}'  cases=${s.cases?.length ?? '?'}`);
  total += s.cases?.length ?? 0;
}
console.log('total cases in scenarios:', total);
console.log('looseCases field:', d?.looseCases, '(len=', (d?.looseCases ?? []).length, ')');
console.log('loose_cases (snake?) field present:', 'loose_cases' in (d ?? {}));
console.log('keys with "case":', Object.keys(d ?? {}).filter(k => /case/i.test(k)));

await pool.end();
