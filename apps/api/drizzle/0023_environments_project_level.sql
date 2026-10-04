-- 0023: 环境提升项目级 + environment_objects 子表 + 版本关联环境
-- 目标模型：
--   projects 1─N test_environments（项目级；is_default 项目内唯一）
--   test_environments 1─N environment_objects（type 'db'|'syslog'；payload jsonb；(env,type) 内唯一默认）
--   project_versions.environment_id（可空 FK → test_environments，ON DELETE SET NULL）
-- 存量迁移：非秘密字段指纹去重（保留最早）→ 版本指向原属环境 → 项目默认取默认版本的环境 → 平铺列转对象行 → 删旧列。

-- 1) environment_objects
CREATE TABLE IF NOT EXISTS "environment_objects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "environment_id" uuid NOT NULL REFERENCES "test_environments"("id") ON DELETE CASCADE,
  "object_type" varchar(32) NOT NULL,
  "label" varchar(120) NOT NULL DEFAULT '默认',
  "payload" jsonb NOT NULL DEFAULT '{}',
  "is_default" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS environment_objects_env_idx ON "environment_objects"("environment_id");
CREATE UNIQUE INDEX IF NOT EXISTS environment_objects_env_type_default_uq
  ON "environment_objects"("environment_id", "object_type") WHERE "is_default";

-- 2) 环境项目级默认（项目内至多一个）
ALTER TABLE "test_environments" ADD COLUMN IF NOT EXISTS "is_default" boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS test_environments_project_default_uq
  ON "test_environments"("project_id") WHERE "is_default";

-- 3) 版本关联
ALTER TABLE "project_versions" ADD COLUMN IF NOT EXISTS "environment_id" uuid
  REFERENCES "test_environments"("id") ON DELETE SET NULL;

-- 4) 指纹去重：非秘密配置完全相同 → 保留最早一条（密文含随机 IV 无法比对，幸存者密钥生效）
DO $$
DECLARE
  v record;
  survivor uuid;
BEGIN
  FOR v IN
    SELECT project_id, db_host, db_port, db_name, db_user,
           syslog_host, syslog_user, syslog_ssh_port, syslog_file_path
    FROM test_environments
    GROUP BY project_id, db_host, db_port, db_name, db_user,
             syslog_host, syslog_user, syslog_ssh_port, syslog_file_path
    HAVING count(*) > 1
  LOOP
    SELECT id INTO survivor FROM test_environments
     WHERE project_id = v.project_id
       AND COALESCE(db_host,'')        = COALESCE(v.db_host,'')
       AND COALESCE(db_port,0)         = COALESCE(v.db_port,0)
       AND COALESCE(db_name,'')        = COALESCE(v.db_name,'')
       AND COALESCE(db_user,'')        = COALESCE(v.db_user,'')
       AND COALESCE(syslog_host,'')    = COALESCE(v.syslog_host,'')
       AND COALESCE(syslog_user,'')    = COALESCE(v.syslog_user,'')
       AND COALESCE(syslog_ssh_port,0) = COALESCE(v.syslog_ssh_port,0)
       AND COALESCE(syslog_file_path,'') = COALESCE(v.syslog_file_path,'')
     ORDER BY created_at, id
     LIMIT 1;
    UPDATE project_versions SET environment_id = survivor
     WHERE environment_id IN (
       SELECT id FROM test_environments
        WHERE project_id = v.project_id
          AND COALESCE(db_host,'')        = COALESCE(v.db_host,'')
          AND COALESCE(db_port,0)         = COALESCE(v.db_port,0)
          AND COALESCE(db_name,'')        = COALESCE(v.db_name,'')
          AND COALESCE(db_user,'')        = COALESCE(v.db_user,'')
          AND COALESCE(syslog_host,'')    = COALESCE(v.syslog_host,'')
          AND COALESCE(syslog_user,'')    = COALESCE(v.syslog_user,'')
          AND COALESCE(syslog_ssh_port,0) = COALESCE(v.syslog_ssh_port,0)
          AND COALESCE(syslog_file_path,'') = COALESCE(v.syslog_file_path,'')
          AND id <> survivor);
    DELETE FROM test_environments
     WHERE project_id = v.project_id
       AND COALESCE(db_host,'')        = COALESCE(v.db_host,'')
       AND COALESCE(db_port,0)         = COALESCE(v.db_port,0)
       AND COALESCE(db_name,'')        = COALESCE(v.db_name,'')
       AND COALESCE(db_user,'')        = COALESCE(v.db_user,'')
       AND COALESCE(syslog_host,'')    = COALESCE(v.syslog_host,'')
       AND COALESCE(syslog_user,'')    = COALESCE(v.syslog_user,'')
       AND COALESCE(syslog_ssh_port,0) = COALESCE(v.syslog_ssh_port,0)
       AND COALESCE(syslog_file_path,'') = COALESCE(v.syslog_file_path,'')
       AND id <> survivor;
  END LOOP;
END $$;

-- 5) 每个版本指向它原来拥有的环境（最早一条）；原无环境 → NULL
UPDATE project_versions pv
SET environment_id = e.first_env
FROM (
  SELECT version_id, (ARRAY_AGG(id ORDER BY created_at, id))[1] AS first_env
  FROM test_environments
  GROUP BY version_id
) e
WHERE e.version_id = pv.id;

-- 6) 项目默认环境：默认版本的关联环境优先，否则最早一条
DO $$
DECLARE
  p record;
  env_id uuid;
BEGIN
  FOR p IN SELECT id FROM projects LOOP
    SELECT pv.environment_id INTO env_id
      FROM project_versions pv
     WHERE pv.project_id = p.id AND pv.is_default = true
     ORDER BY pv.created_at, pv.id LIMIT 1;
    IF env_id IS NULL THEN
      SELECT id INTO env_id FROM test_environments WHERE project_id = p.id
       ORDER BY created_at, id LIMIT 1;
    END IF;
    IF env_id IS NOT NULL THEN
      UPDATE test_environments SET is_default = true WHERE id = env_id;
    END IF;
  END LOOP;
END $$;

-- 7) 平铺列 → 对象行（is_default=true，label '默认'；secret 三元组原样搬入 payload.secret）
INSERT INTO "environment_objects" ("environment_id", "object_type", "label", "payload", "is_default")
SELECT id, 'db', '默认',
  jsonb_build_object(
    'host', db_host,
    'port', db_port,
    'dbName', db_name,
    'user', db_user,
    'secret', CASE WHEN db_password_ciphertext IS NOT NULL
      THEN jsonb_build_object('c', db_password_ciphertext, 'i', db_password_iv, 't', db_password_tag)
    END
  ),
  true
FROM test_environments
WHERE db_host IS NOT NULL OR db_name IS NOT NULL OR db_user IS NOT NULL OR db_password_ciphertext IS NOT NULL;

INSERT INTO "environment_objects" ("environment_id", "object_type", "label", "payload", "is_default")
SELECT id, 'syslog', '默认',
  jsonb_build_object(
    'host', syslog_host,
    'user', syslog_user,
    'sshPort', syslog_ssh_port,
    'filePath', syslog_file_path,
    'secret', CASE WHEN syslog_key_ciphertext IS NOT NULL
      THEN jsonb_build_object('c', syslog_key_ciphertext, 'i', syslog_key_iv, 't', syslog_key_tag)
    END
  ),
  true
FROM test_environments
WHERE syslog_host IS NOT NULL OR syslog_user IS NOT NULL OR syslog_key_ciphertext IS NOT NULL OR syslog_file_path IS NOT NULL;

-- 8) 删旧列与旧索引
ALTER TABLE "test_environments"
  DROP COLUMN IF EXISTS db_host,
  DROP COLUMN IF EXISTS db_port,
  DROP COLUMN IF EXISTS db_name,
  DROP COLUMN IF EXISTS db_user,
  DROP COLUMN IF EXISTS db_password_ciphertext,
  DROP COLUMN IF EXISTS db_password_iv,
  DROP COLUMN IF EXISTS db_password_tag,
  DROP COLUMN IF EXISTS syslog_host,
  DROP COLUMN IF EXISTS syslog_user,
  DROP COLUMN IF EXISTS syslog_ssh_port,
  DROP COLUMN IF EXISTS syslog_key_ciphertext,
  DROP COLUMN IF EXISTS syslog_key_iv,
  DROP COLUMN IF EXISTS syslog_key_tag,
  DROP COLUMN IF EXISTS syslog_file_path,
  DROP COLUMN IF EXISTS version_id;
DROP INDEX IF EXISTS test_environments_version_idx;