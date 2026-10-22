-- 0043: 产品线（product_lines）+ 项目归属列
-- 设计：apps/api/src/routes/productLines.ts 建/改/删；apps/api/src/services/plans.service.ts 放宽跨项目用例归属校验
-- 语义：产品线挂在组织下，可见性随组织（visibleOrgIdsFor）自动继承，不另设成员表。
--   projects.product_line_id 可空：空 = 未归入任何产品线，此时计划仍严格限同项目用例。
--   on delete set null：删产品线不牵连项目，项目退回「未归线」状态。
-- 幂等：可重复执行（drizzle-kit push 已在容器启动时建表建列，本文件仅作记录/兜底）。
CREATE TABLE IF NOT EXISTS product_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name varchar(200) NOT NULL,
  description text,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE product_lines ADD CONSTRAINT product_lines_org_name_uq UNIQUE (organization_id, name);
EXCEPTION WHEN duplicate_object THEN null;
END $$;
CREATE INDEX IF NOT EXISTS idx_product_lines_org ON product_lines(organization_id);
DO $$ BEGIN
  ALTER TABLE projects ADD COLUMN product_line_id uuid REFERENCES product_lines(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
CREATE INDEX IF NOT EXISTS idx_projects_product_line ON projects(product_line_id);