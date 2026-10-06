-- 0031: 用例回放测试数据集（spec: docs/superpowers/specs/2026-10-06-replay-dataset-design.md）
CREATE TABLE IF NOT EXISTS datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  description text,
  columns jsonb NOT NULL DEFAULT '[]'::jsonb,
  rows jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE datasets ADD CONSTRAINT datasets_project_name_uq UNIQUE(project_id, name);
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE test_cases ADD COLUMN dataset_id uuid REFERENCES datasets(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE reports ADD COLUMN dataset_row_index integer;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE reports ADD COLUMN dataset_snapshot jsonb;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE plan_run_cases ADD COLUMN report_ids jsonb;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
