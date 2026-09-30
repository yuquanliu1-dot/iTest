import type { Pool } from 'pg';

/** 与迁移完成后一致的全量建表 SQL（测试容器用，不走迁移）。 */
export const SCHEMA_SQL = `
CREATE TABLE projects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(200) NOT NULL, default_url text, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
CREATE TABLE "groups" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid REFERENCES projects(id) ON DELETE CASCADE NOT NULL, name varchar(200) NOT NULL, default_url text, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
CREATE TABLE requirements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid REFERENCES projects(id) ON DELETE CASCADE NOT NULL, title varchar(200) NOT NULL, content text NOT NULL, status varchar(20) NOT NULL DEFAULT 'draft', created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
CREATE TABLE test_cases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), requirement_id uuid REFERENCES requirements(id) ON DELETE CASCADE, group_id uuid REFERENCES "groups"(id) ON DELETE CASCADE NOT NULL, url text, title varchar(200) NOT NULL, description text, priority varchar(20) NOT NULL DEFAULT 'P1', status varchar(20) NOT NULL DEFAULT 'draft', created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
CREATE TABLE test_steps (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), case_id uuid REFERENCES test_cases(id) ON DELETE CASCADE NOT NULL, "order" integer NOT NULL, source varchar(20) NOT NULL, tab_ref varchar(64), sensitive boolean NOT NULL DEFAULT false, component_kind varchar(32), secret_ciphertext text, secret_iv text, secret_tag text, action jsonb NOT NULL, assertion jsonb, name varchar(200), delay_ms integer, created_at timestamp NOT NULL DEFAULT now());
CREATE TABLE agent_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), target_type varchar(30) NOT NULL, target_id uuid NOT NULL, status varchar(20) NOT NULL, prompt text NOT NULL, result jsonb, error text, started_at timestamp NOT NULL DEFAULT now(), finished_at timestamp);
CREATE TABLE reports (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), case_id uuid REFERENCES test_cases(id) ON DELETE CASCADE NOT NULL, agent_run_id uuid REFERENCES agent_runs(id), status varchar(20) NOT NULL, duration_ms integer, step_results jsonb NOT NULL, summary text, created_at timestamp NOT NULL DEFAULT now());
CREATE TABLE settings (key varchar(100) PRIMARY KEY, value jsonb NOT NULL, updated_at timestamp NOT NULL DEFAULT now());
CREATE TABLE execution_plans (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid REFERENCES projects(id) ON DELETE CASCADE NOT NULL, name varchar(200) NOT NULL, environment varchar(100), strategy varchar(20) NOT NULL DEFAULT 'run_all', login_prepare_enabled boolean NOT NULL DEFAULT false, login_case_id uuid, detection_url text, login_success_selector text, login_unauthorized_keywords jsonb, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
DO $$ BEGIN
 ALTER TABLE execution_plans ADD CONSTRAINT execution_plans_login_case_id_test_cases_id_fk FOREIGN KEY (login_case_id) REFERENCES test_cases(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
CREATE TABLE plan_cases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plan_id uuid REFERENCES execution_plans(id) ON DELETE CASCADE NOT NULL, case_id uuid REFERENCES test_cases(id) ON DELETE CASCADE NOT NULL, "order" integer NOT NULL);
CREATE TABLE plan_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plan_id uuid REFERENCES execution_plans(id) ON DELETE CASCADE NOT NULL, project_id uuid REFERENCES projects(id) ON DELETE CASCADE NOT NULL, status varchar(20) NOT NULL, strategy varchar(20) NOT NULL, login_prepare_enabled boolean NOT NULL DEFAULT false, login_case_id uuid REFERENCES test_cases(id) ON DELETE SET NULL, detection_url text, login_success_selector text, login_unauthorized_keywords jsonb, started_at timestamp NOT NULL DEFAULT now(), finished_at timestamp, duration_ms integer, summary text, total_cases integer NOT NULL DEFAULT 0, passed_cases integer, failed_cases integer, skipped_cases integer, cancel_requested boolean NOT NULL DEFAULT false);
CREATE TABLE plan_run_cases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plan_run_id uuid REFERENCES plan_runs(id) ON DELETE CASCADE NOT NULL, case_id uuid REFERENCES test_cases(id) ON DELETE CASCADE NOT NULL, report_id uuid REFERENCES reports(id) ON DELETE SET NULL, "order" integer NOT NULL, status varchar(20) NOT NULL, step_kind varchar(20) NOT NULL, started_at timestamp, finished_at timestamp, duration_ms integer, error text);
CREATE TABLE test_attachments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), case_id uuid REFERENCES test_cases(id) ON DELETE CASCADE NOT NULL, step_id uuid REFERENCES test_steps(id) ON DELETE SET NULL, original_name text NOT NULL, mime text, size integer NOT NULL, sha256 varchar(64) NOT NULL UNIQUE, stored_path text NOT NULL, created_at timestamp NOT NULL DEFAULT now());
CREATE TABLE test_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), case_id uuid REFERENCES test_cases(id) ON DELETE CASCADE NOT NULL, mode varchar(16) NOT NULL DEFAULT 'fresh', incognito boolean NOT NULL DEFAULT false, resume_from_order integer, tabs jsonb, created_at timestamp NOT NULL DEFAULT now());
`;

/** 造一个项目+默认分组，返回 id 对。所有需要 group_id/project_id 的测试都用它。 */
export async function seedProject(pool: Pool): Promise<{ projectId: string; groupId: string }> {
  const p = await pool.query(`INSERT INTO projects(name) VALUES ('测试项目') RETURNING id`);
  const g = await pool.query(`INSERT INTO "groups"(project_id, name) VALUES ($1, '默认分组') RETURNING id`, [
    p.rows[0]!.id,
  ]);
  return { projectId: p.rows[0]!.id as string, groupId: g.rows[0]!.id as string };
}
