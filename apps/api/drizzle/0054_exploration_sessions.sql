-- 0054: 探索式测试会话两张表（drizzle-kit push 已在 api 容器启动时建表，本文件仅作记录/兜底）
-- exploration_sessions: charter 驱动的 AI 探索会话（不绑定 case，产物是 findings 而非 pass/fail）
-- exploration_findings: 缺陷候选（审阅 pending→confirmed|dismissed→promoted，升格走 test_cases）
CREATE TABLE IF NOT EXISTS exploration_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES project_versions(id) ON DELETE CASCADE,
  title varchar(200) NOT NULL,
  charter text NOT NULL,
  persona varchar(32) NOT NULL DEFAULT 'qa',
  start_url text,
  status varchar(20) NOT NULL DEFAULT 'pending',
  cancel_requested boolean NOT NULL DEFAULT false,
  summary text,
  error text,
  turns_used integer NOT NULL DEFAULT 0,
  usage jsonb,
  env_id uuid,
  started_at timestamp,
  finished_at timestamp,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS exploration_sessions_project_idx ON exploration_sessions (project_id, created_at);
CREATE INDEX IF NOT EXISTS exploration_sessions_version_idx ON exploration_sessions (version_id);

CREATE TABLE IF NOT EXISTS exploration_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES exploration_sessions(id) ON DELETE CASCADE,
  "order" integer NOT NULL,
  title varchar(200) NOT NULL,
  description text NOT NULL,
  severity varchar(8) NOT NULL DEFAULT 'P2',
  repro_steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  actions_trail jsonb,
  screenshot_path text,
  page_url text,
  status varchar(16) NOT NULL DEFAULT 'pending',
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamp,
  promoted_case_id uuid,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS exploration_findings_session_idx ON exploration_findings (session_id, status);
