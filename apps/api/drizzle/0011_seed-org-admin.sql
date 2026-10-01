--> statement-breakpoint
-- 种子：默认组织 + admin 管理员（首登强制改密）+ 存量项目回填
-- 组织 path 内嵌自身 id，用 CTE 先算 id 再插入
WITH "o" AS (
  SELECT gen_random_uuid() AS "id"
),
"ins_org" AS (
  INSERT INTO "organizations" ("id", "name", "parent_id", "path", "description")
  SELECT "id", 'Default Organization', NULL, '/' || "id"::text || '/', '默认组织' FROM "o"
  RETURNING "id"
),
"ins_user" AS (
  INSERT INTO "users" ("username", "password_hash", "display_name", "must_change_password", "password_updated_at")
  -- bcrypt('admin123', rounds=10)；password_updated_at 为 NULL 表示首登强制改密
  VALUES ('admin', '$2b$10$EuSW57DEuz/Vt8.zjax5rexefbHqvuIjgudaX64ThAJkHat2rmj9y', '管理员', true, NULL)
  RETURNING "id"
)
INSERT INTO "organization_members" ("organization_id", "user_id", "is_manager", "is_user")
SELECT "ins_org"."id", "ins_user"."id", true, true FROM "ins_org", "ins_user";
--> statement-breakpoint
-- 存量项目全部归入默认组织
UPDATE "projects" SET "organization_id" = (
  SELECT "m"."organization_id" FROM "organization_members" "m"
  JOIN "users" "u" ON "u"."id" = "m"."user_id"
  WHERE "u"."username" = 'admin'
) WHERE "organization_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "organization_id" SET NOT NULL;
