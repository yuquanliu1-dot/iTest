CREATE TABLE "project_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "name" varchar(80) NOT NULL,
  "description" text,
  "is_default" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  UNIQUE ("project_id","name")
);
CREATE INDEX "project_versions_project_idx" ON "project_versions"("project_id");

DO $$ BEGIN
  ALTER TABLE "test_environments" ADD COLUMN "version_id" uuid;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE "test_cases" ADD COLUMN "version_id" uuid;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE "execution_plans" ADD COLUMN "version_id" uuid;
EXCEPTION WHEN duplicate_column THEN null;
END $$;

-- 回填：每项目建一个 'v0' 默认版本；现存数据全部归到 v0
INSERT INTO project_versions (project_id, name, is_default)
SELECT id, 'v0', true FROM projects
WHERE NOT EXISTS (
  SELECT 1 FROM project_versions v WHERE v.project_id = projects.id AND v.is_default = true
);

UPDATE test_environments e SET version_id = v.id
FROM project_versions v WHERE v.project_id = e.project_id AND v.is_default = true
  AND e.version_id IS NULL;

UPDATE test_cases c SET version_id = v.id
FROM "groups" g, project_versions v
WHERE g.id = c.group_id AND v.project_id = g.project_id AND v.is_default = true
  AND c.version_id IS NULL;

UPDATE execution_plans p SET version_id = v.id
FROM project_versions v WHERE v.project_id = p.project_id AND v.is_default = true
  AND p.version_id IS NULL;

-- 加 FK + NOT NULL（test_cases / test_environments 必填；execution_plans 可空）
DO $$ BEGIN
  ALTER TABLE "test_environments"
    ADD CONSTRAINT "test_environments_version_id_project_versions_id_fk"
    FOREIGN KEY ("version_id") REFERENCES "project_versions"("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE "test_environments" ALTER COLUMN "version_id" SET NOT NULL;
EXCEPTION WHEN not_null_violation THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "test_cases"
    ADD CONSTRAINT "test_cases_version_id_project_versions_id_fk"
    FOREIGN KEY ("version_id") REFERENCES "project_versions"("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE "test_cases" ALTER COLUMN "version_id" SET NOT NULL;
EXCEPTION WHEN not_null_violation THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "execution_plans"
    ADD CONSTRAINT "execution_plans_version_id_project_versions_id_fk"
    FOREIGN KEY ("version_id") REFERENCES "project_versions"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE INDEX "test_environments_version_idx" ON "test_environments"("version_id");
CREATE INDEX "test_cases_version_idx"        ON "test_cases"("version_id");
CREATE INDEX "execution_plans_version_idx"   ON "execution_plans"("version_id");