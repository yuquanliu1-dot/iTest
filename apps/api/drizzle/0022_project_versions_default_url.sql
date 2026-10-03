DO $$ BEGIN
  ALTER TABLE "project_versions" ADD COLUMN "default_url" text;
EXCEPTION WHEN duplicate_column THEN null;
END $$;