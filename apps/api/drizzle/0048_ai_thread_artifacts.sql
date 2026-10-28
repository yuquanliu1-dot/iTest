-- 0048: ai_thread_artifacts —— AI 助手产物文件登记表（skill 脚本生成的可下载文档）
-- 语义：skill 脚本产出文件 → 工具层 registerPersistentArtifact 落盘（.data/exports/<token><ext>）
--        + 落库（此表）→ SSE artifact 事件 → 前端下载卡 → GET /threads/:id/artifacts/:token 下载。
-- 设计取舍：
--   - thread_id/version_id/project_id 是裸 uuid 无 FK，与 ai_assistant_feedback 同惯例：
--     产物是已交付给用户的材料，不应随 version 删除而 cascade 消失（文件本体在卷上也不随之清理）。
--   - token 用 UUID 形态并加唯一约束：下载路由的 TOKEN_RE 校验对「短 TTL 产物」与「永久产物」
--     一视同仁，同一 token 至多指向一个文件。
--   - expires_at 为 null = 永久有效。skill 产物走永久（用户常隔天再下载报告）；
--     旧的 xmind 导出仍走内存态 30 分钟 TTL，不落此表。
-- 执行路径：生产迁移为 drizzle-kit push --force（apps/api/src/db/migrate.ts 持 advisory lock），
--        直接 diff src/db/schema.ts 建表建索引；本文件仅作记录/兜底，不自动执行。
-- 幂等：可重复执行。
CREATE TABLE IF NOT EXISTS ai_thread_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL,
  version_id uuid NOT NULL,
  project_id uuid NOT NULL,
  token text NOT NULL,
  name text NOT NULL,
  mime text,
  size integer NOT NULL,
  count integer,
  stored_path text NOT NULL,
  skill_name text,
  expires_at timestamp,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_thread_artifacts_token_uq ON ai_thread_artifacts(token);
CREATE INDEX IF NOT EXISTS ai_thread_artifacts_thread_idx ON ai_thread_artifacts(thread_id);
CREATE INDEX IF NOT EXISTS ai_thread_artifacts_version_idx ON ai_thread_artifacts(version_id);
