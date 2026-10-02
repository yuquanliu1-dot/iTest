-- Tags 改组织级共享。
-- 1) 旧 FK 仍引用 project_id 列；rename 列前先 drop FK
-- 2) 重命名 tags.project_id -> organization_id
-- 3) 用 projects 表把旧 project_id 解析为 organization_id 完成回填
-- 4) 加新 FK + 唯一约束
DO $$ BEGIN
  ALTER TABLE "tags" DROP CONSTRAINT IF EXISTS "tags_project_id_projects_id_fk";
EXCEPTION WHEN undefined_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tags" RENAME COLUMN "project_id" TO "organization_id";
EXCEPTION WHEN undefined_column THEN null;
END $$;
--> statement-breakpoint
UPDATE "tags" t
SET "organization_id" = p."organization_id"
FROM "projects" p
WHERE p."id" = t."organization_id"::uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tags" DROP CONSTRAINT IF EXISTS "tags_project_name_uq";
EXCEPTION WHEN undefined_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tags" ADD CONSTRAINT "tags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tags" ADD CONSTRAINT "tags_org_name_uq" UNIQUE("organization_id","name");
EXCEPTION WHEN duplicate_object THEN null;
END $$;
