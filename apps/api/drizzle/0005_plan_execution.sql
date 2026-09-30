CREATE TABLE IF NOT EXISTS "plan_run_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_run_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"report_id" uuid,
	"order" integer NOT NULL,
	"status" varchar(20) NOT NULL,
	"step_kind" varchar(20) NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	"duration_ms" integer,
	"error" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plan_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"status" varchar(20) NOT NULL,
	"strategy" varchar(20) NOT NULL,
	"login_prepare_enabled" boolean DEFAULT false NOT NULL,
	"login_case_id" uuid,
	"detection_url" text,
	"login_success_selector" text,
	"login_unauthorized_keywords" jsonb,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"duration_ms" integer,
	"summary" text,
	"total_cases" integer DEFAULT 0 NOT NULL,
	"passed_cases" integer,
	"failed_cases" integer,
	"skipped_cases" integer,
	"cancel_requested" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "execution_plans" ADD COLUMN "strategy" varchar(20) DEFAULT 'run_all' NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_plans" ADD COLUMN "login_prepare_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_plans" ADD COLUMN "login_case_id" uuid;--> statement-breakpoint
ALTER TABLE "execution_plans" ADD COLUMN "detection_url" text;--> statement-breakpoint
ALTER TABLE "execution_plans" ADD COLUMN "login_success_selector" text;--> statement-breakpoint
ALTER TABLE "execution_plans" ADD COLUMN "login_unauthorized_keywords" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plan_run_cases" ADD CONSTRAINT "plan_run_cases_plan_run_id_plan_runs_id_fk" FOREIGN KEY ("plan_run_id") REFERENCES "public"."plan_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plan_run_cases" ADD CONSTRAINT "plan_run_cases_case_id_test_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."test_cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plan_run_cases" ADD CONSTRAINT "plan_run_cases_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plan_runs" ADD CONSTRAINT "plan_runs_plan_id_execution_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."execution_plans"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plan_runs" ADD CONSTRAINT "plan_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plan_runs" ADD CONSTRAINT "plan_runs_login_case_id_test_cases_id_fk" FOREIGN KEY ("login_case_id") REFERENCES "public"."test_cases"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_plans" ADD CONSTRAINT "execution_plans_login_case_id_test_cases_id_fk" FOREIGN KEY ("login_case_id") REFERENCES "public"."test_cases"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
