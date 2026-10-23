-- 0044: 删掉 projects.organization_id，product_line_id 改必填
-- 语义：项目所属组织恒等于其产品线的组织，从「应用层同步的冗余快照」升级为「结构不变式」。
--   移动一条产品线因此只需 UPDATE product_lines SET organization_id = ?，线下项目自动换组织
--   （apps/api/src/services/productLineMove.ts），不再有任何同步代码。
--   product_line_id NOT NULL + ON DELETE RESTRICT：不再存在「未归线项目」这种状态；
--   删产品线若仍挂着项目，由 D1 的 409 line_not_empty 先拦，FK 兜底防止打成孤儿。
-- 不可回滚：drop column 没有反向 DDL。发版前必须先过下面两道脏数据闸门（都要为 0）。
--
--   SELECT count(*) FROM projects WHERE product_line_id IS NULL;
--   SELECT count(*) FROM projects p JOIN product_lines l ON l.id = p.product_line_id
--    WHERE p.organization_id IS DISTINCT FROM l.organization_id;
--
-- 幂等：可重复执行（drizzle-kit push 已在容器启动时改列，本文件仅作记录/兜底）。
--
-- 闸门：产品线必须指向真实存在的行（NOT NULL 会顺带暴露悬空引用，故先显式卡一道更可读的报错）。
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM projects WHERE product_line_id IS NULL) THEN
    RAISE EXCEPTION 'projects without product_line_id remain; attach them to a product line first';
  END IF;
  IF EXISTS (
    SELECT 1 FROM projects p LEFT JOIN product_lines l ON l.id = p.product_line_id
     WHERE p.product_line_id IS NOT NULL AND l.id IS NULL
  ) THEN
    RAISE EXCEPTION 'projects referencing a missing product_line_id exist; fix the dangling rows first';
  END IF;
END $$;

DO $$ BEGIN
  ALTER TABLE projects ALTER COLUMN product_line_id SET NOT NULL;
EXCEPTION WHEN others THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_product_line_id_fkey;
EXCEPTION WHEN others THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE projects ADD CONSTRAINT projects_product_line_id_fkey
    FOREIGN KEY (product_line_id) REFERENCES product_lines(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- 最后才丢列：上面任一闸门/改列失败时 organization_id 仍在，可人工回查。
ALTER TABLE projects DROP COLUMN IF EXISTS organization_id;