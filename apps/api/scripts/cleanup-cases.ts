import { pool } from '../src/db/client.ts';
const ids = [
  '13f530b7-42c1-491c-ba4e-3c17bb7a8c9b',
  '5a0f6bf6-bce7-493e-9bc9-a05f3640f466',
  '5c2d17a8-9b08-4410-8c3f-5f79e83e39f2',
  'a7369456-81a7-40fe-b543-0b7b1909585a',
  'd3f2712e-47bb-44b3-befe-a390f670cef3',
];
for (const id of ids) {
  const r = await pool.query(`DELETE FROM test_cases WHERE id = $1`, [id]);
  console.log(`deleted ${id}: ${r.rowCount}`);
}
await pool.end();