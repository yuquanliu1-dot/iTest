/**
 * Backfill for existing plans (idempotent, safe to re-run in any state):
 * 1. Plans that have cases but no group yet → create a '默认分组' (default group), copying the plan-level environment + login config,
 *    fail_fast = (plan strategy = 'fail_fast');
 * 2. plan_cases rows with empty group_id are all attached to their plan's default group (in-group order follows the original global order).
 * Empty plans get no group. Timing: after migrate.ts acquires the advisory lock, before drizzle-kit push —
 * only then can push safely set group_id to NOT NULL.
 * Once the plan-level legacy columns are dropped by later migrations, this function becomes an automatic no-op (the backfill segment is skipped when the columns don't exist).
 *
 * The parameter is relaxed to a structured query: compatible with both pg.Pool and migrate.ts's pg.Client.
 */
export async function backfillPlanCaseGroups(client: { query: (sql: string) => Promise<unknown> }): Promise<void> {
  // Column existence probe: skip entirely when legacy columns are gone (post-migration) or the DB is fresh (no tables).
  const cols = (await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'execution_plans'`,
  )) as { rows: Array<{ column_name: string }> };
  const has = (c: string) => cols.rows.some((r) => r.column_name === c);
  if (!has('login_prepare_enabled')) return; // column-drop migration already done (or fresh DB), nothing to do

  // Tables/columns may not exist yet before push (first upgrade of an old DB): apply idempotent DDL first so the backfill below can run safely.
  await client.query(`
    CREATE TABLE IF NOT EXISTS plan_case_groups (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_id uuid REFERENCES execution_plans(id) ON DELETE CASCADE NOT NULL,
      name varchar(200) NOT NULL,
      "order" integer NOT NULL,
      environment_id uuid REFERENCES test_environments(id) ON DELETE SET NULL,
      login_prepare_enabled boolean NOT NULL DEFAULT false,
      login_case_id uuid REFERENCES test_cases(id) ON DELETE SET NULL,
      detection_url text,
      login_success_selector text,
      login_unauthorized_keywords jsonb,
      fail_fast boolean NOT NULL DEFAULT false,
      target_config jsonb,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_plan_case_groups_plan_order ON plan_case_groups(plan_id, "order");
    ALTER TABLE plan_cases ADD COLUMN IF NOT EXISTS group_id uuid;
  `);
  await client.query(`
    INSERT INTO plan_case_groups (id, plan_id, name, "order", environment_id, login_prepare_enabled,
      login_case_id, detection_url, login_success_selector, login_unauthorized_keywords, fail_fast)
    SELECT gen_random_uuid(), p.id, '默认分组', 0, p.environment_id, p.login_prepare_enabled,
      p.login_case_id, p.detection_url, p.login_success_selector, p.login_unauthorized_keywords,
      (p.strategy = 'fail_fast')
    FROM execution_plans p
    WHERE EXISTS (SELECT 1 FROM plan_cases pc WHERE pc.plan_id = p.id AND pc.group_id IS NULL)
      AND NOT EXISTS (SELECT 1 FROM plan_case_groups g WHERE g.plan_id = p.id)
  `);
  await client.query(`
    UPDATE plan_cases pc SET group_id = g.id
    FROM plan_case_groups g
    WHERE g.plan_id = pc.plan_id AND pc.group_id IS NULL
  `);
}
