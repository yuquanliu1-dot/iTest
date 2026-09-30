CREATE TABLE IF NOT EXISTS "test_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"step_id" uuid,
	"original_name" text NOT NULL,
	"mime" text,
	"size" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"stored_path" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "test_attachments_sha256_unique" UNIQUE("sha256")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "test_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"mode" varchar(16) DEFAULT 'fresh' NOT NULL,
	"incognito" boolean DEFAULT false NOT NULL,
	"resume_from_order" integer,
	"tabs" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "test_steps" ADD COLUMN "tab_ref" varchar(64);--> statement-breakpoint
ALTER TABLE "test_steps" ADD COLUMN "sensitive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "test_steps" ADD COLUMN "component_kind" varchar(32);--> statement-breakpoint
ALTER TABLE "test_steps" ADD COLUMN "secret_ciphertext" text;--> statement-breakpoint
ALTER TABLE "test_steps" ADD COLUMN "secret_iv" text;--> statement-breakpoint
ALTER TABLE "test_steps" ADD COLUMN "secret_tag" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "test_attachments" ADD CONSTRAINT "test_attachments_case_id_test_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."test_cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "test_attachments" ADD CONSTRAINT "test_attachments_step_id_test_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."test_steps"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "test_sessions" ADD CONSTRAINT "test_sessions_case_id_test_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."test_cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
