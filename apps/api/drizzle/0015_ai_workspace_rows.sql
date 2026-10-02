CREATE TABLE IF NOT EXISTS "ai_cases" (
	"requirement_id" uuid NOT NULL,
	"id" text NOT NULL,
	"scenario_id" text,
	"title" varchar(200) NOT NULL,
	"description" text,
	"priority" varchar(20) DEFAULT 'P1' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ai_cases_requirement_id_id_pk" PRIMARY KEY("requirement_id","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_scenarios" (
	"requirement_id" uuid NOT NULL,
	"id" text NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text,
	"order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ai_scenarios_requirement_id_id_pk" PRIMARY KEY("requirement_id","id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_cases" ADD CONSTRAINT "ai_cases_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_scenarios" ADD CONSTRAINT "ai_scenarios_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_cases_requirement_scenario_idx" ON "ai_cases" USING btree ("requirement_id","scenario_id");