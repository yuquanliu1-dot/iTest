--> statement-breakpoint
WITH "dp" AS (
  INSERT INTO "projects" ("name") VALUES ('默认项目') RETURNING "id"
),
"dg" AS (
  INSERT INTO "groups" ("project_id", "name") SELECT "id", '默认分组' FROM "dp" RETURNING "id"
)
UPDATE "test_cases" SET "group_id" = (SELECT "id" FROM "dg") WHERE "group_id" IS NULL;
--> statement-breakpoint
UPDATE "requirements" SET "project_id" = (SELECT "id" FROM "projects" ORDER BY "created_at" ASC LIMIT 1) WHERE "project_id" IS NULL;
