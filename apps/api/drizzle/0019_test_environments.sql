CREATE TABLE "test_environments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "name" varchar(120) NOT NULL,
  "db_host" varchar(200),
  "db_port" integer,
  "db_name" varchar(120),
  "db_user" varchar(120),
  "db_password_ciphertext" text,
  "db_password_iv" text,
  "db_password_tag" text,
  "syslog_host" varchar(200),
  "syslog_user" varchar(120),
  "syslog_ssh_port" integer DEFAULT 22,
  "syslog_key_ciphertext" text,
  "syslog_key_iv" text,
  "syslog_key_tag" text,
  "syslog_file_path" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  UNIQUE ("project_id","name")
);

DO $$ BEGIN
  ALTER TABLE "test_cases" ADD COLUMN "default_env_id" uuid REFERENCES "test_environments"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_column THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "execution_plans" ADD COLUMN "environment_id" uuid REFERENCES "test_environments"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
