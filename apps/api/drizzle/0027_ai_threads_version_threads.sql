-- 0027: ai_threads 双类型线程。存量行 kind='requirement' 语义不变(一需求一线程);
-- 新增 version 级空间助手线程(一版本多线程,可空 requirement_id,带标题)。
ALTER TABLE ai_threads ADD COLUMN kind varchar(20) NOT NULL DEFAULT 'requirement';
ALTER TABLE ai_threads ADD COLUMN version_id uuid REFERENCES project_versions(id) ON DELETE CASCADE;
ALTER TABLE ai_threads ADD COLUMN title text;
ALTER TABLE ai_threads ALTER COLUMN requirement_id DROP NOT NULL;
ALTER TABLE ai_threads DROP CONSTRAINT ai_threads_requirement_id_key;
CREATE UNIQUE INDEX ai_threads_requirement_uq ON ai_threads(requirement_id);
CREATE INDEX ai_threads_version_idx ON ai_threads(version_id);
