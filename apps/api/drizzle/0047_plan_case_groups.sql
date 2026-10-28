-- 0047: 执行计划用例分组。plan_case_groups 新表 + plan_cases.group_id（回填后 NOT NULL）
--        + plan_runs.groups 快照 + plan_run_cases 组列。
-- 语义：一计划 = 有序分组的串行执行流；组级环境/登录准备/fail_fast/target_config；
--        计划级 strategy 管组间失败传导。存量计划回迁为单个「默认分组」。
-- 执行路径：数据回填在 api 启动 migrate.ts 的 advisory lock 窗口内、drizzle-kit push 之前
--        （apps/api/src/db/backfillPlanCaseGroups.ts）；本文件为记录/兜底，不自动执行。
-- 幂等：可重复执行。
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
ALTER TABLE plan_runs ADD COLUMN IF NOT EXISTS groups jsonb;
ALTER TABLE plan_run_cases ADD COLUMN IF NOT EXISTS group_id uuid;
ALTER TABLE plan_run_cases ADD COLUMN IF NOT EXISTS group_name varchar(200);
ALTER TABLE plan_run_cases ADD COLUMN IF NOT EXISTS group_order integer;
-- 数据回填见 backfillPlanCaseGroups.ts（DO 块版本，幂等）：
DO $$ BEGIN
  INSERT INTO plan_case_groups (id, plan_id, name, "order", environment_id, login_prepare_enabled,
    login_case_id, detection_url, login_success_selector, login_unauthorized_keywords, fail_fast)
  SELECT gen_random_uuid(), p.id, '默认分组', 0, p.environment_id, p.login_prepare_enabled,
    p.login_case_id, p.detection_url, p.login_success_selector, p.login_unauthorized_keywords,
    (p.strategy = 'fail_fast')
  FROM execution_plans p
  WHERE EXISTS (SELECT 1 FROM plan_cases pc WHERE pc.plan_id = p.id AND pc.group_id IS NULL)
    AND NOT EXISTS (SELECT 1 FROM plan_case_groups g WHERE g.plan_id = p.id);
EXCEPTION WHEN undefined_column THEN null;
END $$;
DO $$ BEGIN
  UPDATE plan_cases pc SET group_id = g.id
  FROM plan_case_groups g
  WHERE g.plan_id = pc.plan_id AND pc.group_id IS NULL;
EXCEPTION WHEN undefined_column THEN null;
END $$;
