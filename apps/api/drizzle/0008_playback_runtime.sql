ALTER TABLE "test_cases" ADD COLUMN "window_strategy" varchar(16) NOT NULL DEFAULT 'maximize';--> statement-breakpoint
ALTER TABLE "test_cases" ADD COLUMN "window_width" integer;--> statement-breakpoint
ALTER TABLE "test_cases" ADD COLUMN "window_height" integer;--> statement-breakpoint
ALTER TABLE "test_cases" ADD COLUMN "incognito" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "preflight" jsonb;