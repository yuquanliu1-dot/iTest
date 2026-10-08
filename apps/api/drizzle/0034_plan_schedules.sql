-- 0034: 执行计划调度（cron 定时执行）
-- 设计：apps/api/src/scheduler/*.ts
-- 触发方式：cron 表达式（5 字段）按 timezone 重复执行；与 iDO Automation 对齐。
-- 「立即执行」沿用现有「一键执行」按钮；不再提供 one_shot / interval。
-- BullMQ 在 API 进程启动时 reconcileAllSchedules() 把 enabled=true 的全部入队。
CREATE TABLE plan_schedules (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id             uuid NOT NULL REFERENCES execution_plans(id) ON DELETE CASCADE,
  enabled             boolean NOT NULL DEFAULT true,
  cron_expr           varchar(120) NOT NULL,
  timezone            varchar(64) NOT NULL DEFAULT 'Asia/Shanghai',
  last_run_at         timestamp,
  next_run_at         timestamp,
  created_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamp NOT NULL DEFAULT now(),
  updated_at          timestamp NOT NULL DEFAULT now()
);
CREATE INDEX plan_schedules_plan_idx ON plan_schedules(plan_id);

-- plan_runs 加列：标识触发来源 + actor + 关联 schedule
ALTER TABLE plan_runs ADD COLUMN triggered_by varchar(20) NOT NULL DEFAULT 'manual';
ALTER TABLE plan_runs ADD COLUMN triggered_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE plan_runs ADD COLUMN schedule_id uuid;
DO $$ BEGIN
    ALTER TABLE plan_runs ADD CONSTRAINT plan_runs_schedule_id_fk FOREIGN KEY (schedule_id) REFERENCES plan_schedules(id) ON DELETE SET NULL;
  EXCEPTION WHEN duplicate_object THEN null;
  END $$;