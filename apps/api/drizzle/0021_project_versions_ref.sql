DO $$ BEGIN
  ALTER TABLE "project_versions" ADD COLUMN "ref" varchar(200);
EXCEPTION WHEN duplicate_column THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "project_versions" ADD COLUMN "ref_kind" varchar(16);
EXCEPTION WHEN duplicate_column THEN null;
END $$;
