-- 版本空间 AI 助手「暂存表」(thread-scoped):AI 在 stage_* 工具里写这里,
-- 用户在前端 StagePanel 勾选 → /stage/save 一并落正式表。
-- 与 ai_workspace_* (requirementId-keyed) 并列存在,但不共享:本批按 threadId+localId 复合主键,
-- 不依赖 requirementId(groupId 在 save 时由用户在 SaveDialog 选定)。
CREATE TABLE ai_stage_cases (
  local_id         TEXT NOT NULL,
  thread_id        TEXT NOT NULL,
  version_id       UUID NOT NULL,
  title            TEXT NOT NULL,
  description      TEXT,
  priority         TEXT,
  url              TEXT,
  steps            JSONB NOT NULL DEFAULT '[]',
  default_env_id   UUID,
  expected_outcome TEXT,
  staged_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thread_id, local_id)
);
CREATE INDEX ai_stage_cases_version_idx ON ai_stage_cases(version_id);

CREATE TABLE ai_stage_scenarios (
  local_id        TEXT NOT NULL,
  thread_id       TEXT NOT NULL,
  version_id      UUID NOT NULL,
  requirement_id  UUID NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  case_local_ids  TEXT[] NOT NULL DEFAULT '{}',
  staged_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thread_id, local_id)
);
CREATE INDEX ai_stage_scenarios_version_idx ON ai_stage_scenarios(version_id);

CREATE TABLE ai_stage_environments (
  local_id        TEXT NOT NULL,
  thread_id       TEXT NOT NULL,
  version_id      UUID NOT NULL,
  name            TEXT NOT NULL,
  base_url        TEXT,
  objects         JSONB NOT NULL DEFAULT '[]',
  staged_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thread_id, local_id)
);
CREATE INDEX ai_stage_environments_version_idx ON ai_stage_environments(version_id);

CREATE TABLE ai_stage_plans (
  local_id        TEXT NOT NULL,
  thread_id       TEXT NOT NULL,
  version_id      UUID NOT NULL,
  name            TEXT NOT NULL,
  environment_id  UUID,
  case_local_ids  TEXT[] NOT NULL DEFAULT '{}',
  staged_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thread_id, local_id)
);
CREATE INDEX ai_stage_plans_version_idx ON ai_stage_plans(version_id);
