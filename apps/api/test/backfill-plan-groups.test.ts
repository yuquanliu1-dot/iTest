import { afterAll, beforeAll, expect, test } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let pool: Pool;

beforeAll(async () => {
  const c = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = c.getConnectionUri();
  process.env.ENCRYPTION_KEY = 'test-encryption-key-32bytes-padding!';
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(SCHEMA_SQL);
});

afterAll(async () => {
  await pool?.end();
});

async function makePlan(name: string, strategy = 'run_all'): Promise<string> {
  const s = await seedProject(pool);
  // SCHEMA_SQL 已删计划级旧列——手动补回模拟存量库（回填对象是带旧列的库）
  await pool.query(`ALTER TABLE execution_plans ADD COLUMN IF NOT EXISTS environment_id uuid`);
  await pool.query(`ALTER TABLE execution_plans ADD COLUMN IF NOT EXISTS login_prepare_enabled boolean DEFAULT false`);
  await pool.query(`ALTER TABLE execution_plans ADD COLUMN IF NOT EXISTS login_case_id uuid`);
  await pool.query(`ALTER TABLE execution_plans ADD COLUMN IF NOT EXISTS detection_url text`);
  await pool.query(`ALTER TABLE execution_plans ADD COLUMN IF NOT EXISTS login_success_selector text`);
  await pool.query(`ALTER TABLE execution_plans ADD COLUMN IF NOT EXISTS login_unauthorized_keywords jsonb`);
  const p = await pool.query(
    `INSERT INTO execution_plans(project_id, version_id, name, environment_id, strategy, login_prepare_enabled, login_case_id, detection_url, login_success_selector, login_unauthorized_keywords)
     VALUES ($1, $2, $3, NULL, $4, true, NULL, 'https://x/detect', '.ok', '["未登录"]'::jsonb) RETURNING id`,
    [s.projectId, s.versionId, name, strategy],
  );
  const cases = await pool.query(
    `INSERT INTO test_cases(group_id, version_id, title) VALUES ($1, $2, 'c1'), ($1, $2, 'c2') RETURNING id`,
    [s.groupId, s.versionId],
  );
  const ids = cases.rows.map((r) => r.id as string);
  await pool.query(
    `INSERT INTO plan_cases(plan_id, case_id, "order") VALUES ($1, $2, 1), ($1, $3, 2)`,
    [p.rows[0]!.id, ids[0], ids[1]],
  );
  return p.rows[0]!.id as string;
}

test('有用例且无组的计划回迁为默认分组，拷贝环境/登录配置，strategy=fail_fast 映射组 failFast', async () => {
  const planId = await makePlan('回迁A', 'fail_fast');
  const { backfillPlanCaseGroups } = await import('../src/db/backfillPlanCaseGroups.js');
  await backfillPlanCaseGroups(pool);
  const g = await pool.query(`SELECT * FROM plan_case_groups WHERE plan_id = $1`, [planId]);
  expect(g.rows.length).toBe(1);
  expect(g.rows[0]!.name).toBe('默认分组');
  expect(g.rows[0]!.fail_fast).toBe(true);
  expect(g.rows[0]!.login_prepare_enabled).toBe(true);
  expect(g.rows[0]!.detection_url).toBe('https://x/detect');
  const pcs = await pool.query(`SELECT group_id, "order" FROM plan_cases WHERE plan_id = $1 ORDER BY "order"`, [planId]);
  expect(pcs.rows.every((r) => r.group_id === g.rows[0]!.id)).toBe(true);
  expect(pcs.rows.map((r) => r.order)).toEqual([1, 2]);
});

test('幂等：重跑不产生重复组', async () => {
  const planId = await makePlan('回迁B');
  const { backfillPlanCaseGroups } = await import('../src/db/backfillPlanCaseGroups.js');
  await backfillPlanCaseGroups(pool);
  await backfillPlanCaseGroups(pool);
  const n = await pool.query(`SELECT count(*)::int AS n FROM plan_case_groups WHERE plan_id = $1`, [planId]);
  expect(n.rows[0]!.n).toBe(1);
});

test('空计划不建组', async () => {
  const s = await seedProject(pool);
  const p = await pool.query(`INSERT INTO execution_plans(project_id, version_id, name) VALUES ($1, $2, '空计划') RETURNING id`, [s.projectId, s.versionId]);
  const { backfillPlanCaseGroups } = await import('../src/db/backfillPlanCaseGroups.js');
  await backfillPlanCaseGroups(pool);
  const n = await pool.query(`SELECT count(*)::int AS n FROM plan_case_groups WHERE plan_id = $1`, [p.rows[0]!.id]);
  expect(n.rows[0]!.n).toBe(0);
});

test('列缺失 guard：旧列已删（login_prepare_enabled 不存在）时 backfill 直接 no-op 不抛错', async () => {
  await pool.query(`ALTER TABLE execution_plans DROP COLUMN IF EXISTS login_prepare_enabled`);
  const { backfillPlanCaseGroups } = await import('../src/db/backfillPlanCaseGroups.js');
  await expect(backfillPlanCaseGroups(pool)).resolves.toBeUndefined();
});
