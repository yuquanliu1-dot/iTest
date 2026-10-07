-- 0032: 移动端测试支持（spec: docs/superpowers/specs/2026-10-07-mobile-testing-design.md）
CREATE TABLE IF NOT EXISTS device_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name varchar(128) NOT NULL,
  mobile_os varchar(16) NOT NULL,
  device_ref varchar(128) NOT NULL,
  app_bundle_id varchar(256),
  app_path text,
  launch_args jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE device_targets ADD CONSTRAINT device_targets_project_name_uq UNIQUE(project_id, name);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE test_cases ADD COLUMN platform varchar(16) NOT NULL DEFAULT 'web';
EXCEPTION WHEN duplicate_column THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE test_cases ADD COLUMN mobile_os varchar(16);
EXCEPTION WHEN duplicate_column THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE test_cases ADD COLUMN mobile_device_target_id uuid REFERENCES device_targets(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE test_cases ADD COLUMN app_ref jsonb;
EXCEPTION WHEN duplicate_column THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE test_steps ADD COLUMN mobile_os varchar(16);
EXCEPTION WHEN duplicate_column THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE reports ADD COLUMN platform varchar(16) NOT NULL DEFAULT 'web';
EXCEPTION WHEN duplicate_column THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE reports ADD COLUMN mobile_os varchar(16);
EXCEPTION WHEN duplicate_column THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE reports ADD COLUMN device_name varchar(128);
EXCEPTION WHEN duplicate_column THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE reports ADD COLUMN device_target_id uuid REFERENCES device_targets(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_column THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE plan_cases ADD COLUMN target_override jsonb;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
