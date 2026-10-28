/**
 * 存量计划回迁（幂等，可在任何状态重跑）：
 * 1. 有用例且尚无分组的计划 → 建一个「默认分组」，拷贝计划级环境 + 登录配置，
 *    fail_fast = (计划 strategy = 'fail_fast')；
 * 2. group_id 为空的 plan_cases 全部挂入所属计划的默认分组（组内序沿用原全局序）。
 * 空计划不建组。执行时机：migrate.ts 拿到 advisory lock 后、drizzle-kit push 之前——
 * 这样 push 才能安全地把 group_id 置 NOT NULL。
 * 计划级旧列被后续迁移删除后，本函数自动 no-op（列不存在则跳过回填段）。
 *
 * 参数放宽为结构化 query：兼容 pg.Pool 与 migrate.ts 的 pg.Client。
 */
export async function backfillPlanCaseGroups(client: { query: (sql: string) => Promise<unknown> }): Promise<void> {
  // 列存在性探测：旧列已删（迁移完成后）或全新库（无表）则整体跳过。
  const cols = (await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'execution_plans'`,
  )) as { rows: Array<{ column_name: string }> };
  const has = (c: string) => cols.rows.some((r) => r.column_name === c);
  if (!has('login_prepare_enabled')) return; // 已完成删列迁移（或全新库），无事可做

  // push 之前表/列可能尚不存在（老库首次升级）：先补幂等 DDL，保证下述回填可安全执行。
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
