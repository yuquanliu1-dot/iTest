ALTER TABLE "test_attachments" DROP CONSTRAINT "test_attachments_sha256_unique";--> statement-breakpoint
ALTER TABLE "test_attachments" ADD COLUMN "project_id" uuid;--> statement-breakpoint
UPDATE "test_attachments" a
SET "project_id" = c."project_id"
FROM "test_cases" c
WHERE a."case_id" = c."id" AND a."project_id" IS NULL;--> statement-breakpoint
ALTER TABLE "test_attachments" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "test_attachments" ADD CONSTRAINT "test_attachments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "test_attachments" ADD CONSTRAINT "test_attachments_project_sha_uq" UNIQUE("project_id","sha256");