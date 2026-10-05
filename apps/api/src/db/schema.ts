import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  jsonb,
  timestamp,
  boolean,
  unique,
  primaryKey,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const settings = pgTable('settings', {
  key: varchar('key', { length: 100 }).primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const requirements = pgTable('requirements', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: varchar('title', { length: 200 }).notNull(),
  content: text('content').notNull(),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const testCases = pgTable('test_cases', {
  id: uuid('id').primaryKey().defaultRandom(),
  requirementId: uuid('requirement_id').references(() => requirements.id, { onDelete: 'cascade' }),
  groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
  versionId: uuid('version_id').notNull().references(() => projectVersions.id, { onDelete: 'restrict' }),
  url: text('url'),
  title: varchar('title', { length: 200 }).notNull(),
  description: text('description'),
  priority: varchar('priority', { length: 20 }).notNull().default('P1'),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  windowStrategy: varchar('window_strategy', { length: 16 }).notNull().default('maximize'),
  windowWidth: integer('window_width'),
  windowHeight: integer('window_height'),
  incognito: boolean('incognito').notNull().default(false),
  defaultEnvId: uuid('default_env_id').references(() => testEnvironments.id, { onDelete: 'set null' }),
  scenarioId: uuid('scenario_id').references(() => scenarios.id, { onDelete: 'set null' }),
  /** 用例级预期描述（自然语言）。回放阶段结束时由 vision LLM 拿最终截图 + 此字段判终态；
   * 为空/null 时跳过用例级断言（仅按 step.action 是否全部成功判定 pass/fail）。 */
  expectedOutcome: text('expected_outcome'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  versionIdIdx: index('test_cases_version_idx').on(t.versionId),
}));

export const scenarios = pgTable('scenarios', {
  id: uuid('id').primaryKey().defaultRandom(),
  requirementId: uuid('requirement_id').notNull().references(() => requirements.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 200 }).notNull(),
  description: text('description'),
  order: integer('order').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const aiThreads = pgTable('ai_threads', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** 'requirement'(存量需求级生成会话)| 'version'(版本空间助手线程)。 */
  kind: varchar('kind', { length: 20 }).notNull().default('requirement'),
  // requirement 线程 1:1 需求;version 线程此列为 NULL(Postgres 唯一索引不约束 NULL,多条 version 线程合法)
  requirementId: uuid('requirement_id').references(() => requirements.id, { onDelete: 'cascade' }),
  versionId: uuid('version_id').references(() => projectVersions.id, { onDelete: 'cascade' }),
  title: text('title'),
  piThreadId: text('pi_thread_id').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  requirementUq: uniqueIndex('ai_threads_requirement_uq').on(t.requirementId),
  versionIdx: index('ai_threads_version_idx').on(t.versionId),
}));

export const aiWorkspaceState = pgTable('ai_workspace_state', {
  requirementId: uuid('requirement_id').primaryKey().references(() => requirements.id, { onDelete: 'cascade' }),
  doc: jsonb('doc').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const aiScenarios = pgTable(
  'ai_scenarios',
  {
    requirementId: uuid('requirement_id').notNull().references(() => requirements.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    description: text('description'),
    order: integer('order').notNull().default(0),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.requirementId, t.id] }) }),
);

export const aiCases = pgTable(
  'ai_cases',
  {
    requirementId: uuid('requirement_id').notNull().references(() => requirements.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    scenarioId: text('scenario_id'),
    title: varchar('title', { length: 200 }).notNull(),
    description: text('description'),
    priority: varchar('priority', { length: 20 }).notNull().default('P1'),
    steps: jsonb('steps').notNull().default([]),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.requirementId, t.id] }),
    byReqScenario: index('ai_cases_requirement_scenario_idx').on(t.requirementId, t.scenarioId),
  }),
);

// 版本空间助手暂存表（thread-scoped）：AI 在 stage_* 工具里写这里，前端 StagePanel 勾选 → /stage/save 落正式表。
// 与 ai_workspace_*（requirementId-keyed）并列存在但不复用：空间助手无 requirementId，localId 由 LLM 自生成。
export const aiStageCases = pgTable(
  'ai_stage_cases',
  {
    threadId: text('thread_id').notNull(),
    localId: text('local_id').notNull(),
    versionId: uuid('version_id').notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    description: text('description'),
    priority: varchar('priority', { length: 20 }),
    url: text('url'),
    steps: jsonb('steps').notNull().default([]),
    defaultEnvId: uuid('default_env_id'),
    expectedOutcome: text('expected_outcome'),
    stagedAt: timestamp('staged_at').defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.threadId, t.localId] }),
    versionIdx: index('ai_stage_cases_version_idx').on(t.versionId),
  }),
);

export const aiStageScenarios = pgTable(
  'ai_stage_scenarios',
  {
    threadId: text('thread_id').notNull(),
    localId: text('local_id').notNull(),
    versionId: uuid('version_id').notNull(),
    requirementId: uuid('requirement_id').notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    description: text('description'),
    caseLocalIds: text('case_local_ids').array().notNull().default([]),
    stagedAt: timestamp('staged_at').defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.threadId, t.localId] }),
    versionIdx: index('ai_stage_scenarios_version_idx').on(t.versionId),
  }),
);

export const aiStageEnvironments = pgTable(
  'ai_stage_environments',
  {
    threadId: text('thread_id').notNull(),
    localId: text('local_id').notNull(),
    versionId: uuid('version_id').notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    baseUrl: text('base_url'),
    objects: jsonb('objects').notNull().default([]),
    stagedAt: timestamp('staged_at').defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.threadId, t.localId] }),
    versionIdx: index('ai_stage_environments_version_idx').on(t.versionId),
  }),
);

export const aiStagePlans = pgTable(
  'ai_stage_plans',
  {
    threadId: text('thread_id').notNull(),
    localId: text('local_id').notNull(),
    versionId: uuid('version_id').notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    environmentId: uuid('environment_id'),
    caseLocalIds: text('case_local_ids').array().notNull().default([]),
    stagedAt: timestamp('staged_at').defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.threadId, t.localId] }),
    versionIdx: index('ai_stage_plans_version_idx').on(t.versionId),
  }),
);

export const testSteps = pgTable('test_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id').references(() => testCases.id, { onDelete: 'cascade' }).notNull(),
  order: integer('order').notNull(),
  name: varchar('name', { length: 200 }),
  delayMs: integer('delay_ms'),
  source: varchar('source', { length: 20 }).notNull(),
  tabRef: varchar('tab_ref', { length: 64 }),
  sensitive: boolean('sensitive').notNull().default(false),
  componentKind: varchar('component_kind', { length: 32 }),
  secretCiphertext: text('secret_ciphertext'),
  secretIv: text('secret_iv'),
  secretTag: text('secret_tag'),
  action: jsonb('action').notNull(),
  assertion: jsonb('assertion'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const agentRuns = pgTable('agent_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  targetType: varchar('target_type', { length: 30 }).notNull(),
  targetId: uuid('target_id').notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  prompt: text('prompt').notNull(),
  result: jsonb('result'),
  error: text('error'),
  startedAt: timestamp('started_at').defaultNow().notNull(),
  finishedAt: timestamp('finished_at'),
});

export const reports = pgTable('reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id').references(() => testCases.id, { onDelete: 'cascade' }).notNull(),
  agentRunId: uuid('agent_run_id').references(() => agentRuns.id),
  status: varchar('status', { length: 20 }).notNull(),
  durationMs: integer('duration_ms'),
  stepResults: jsonb('step_results').notNull(),
  preflight: jsonb('preflight'),
  summary: text('summary'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: varchar('username', { length: 50 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: varchar('display_name', { length: 100 }).notNull(),
  // null 表示从未改过密码（配合 must_change_password 强制首登改密）
  passwordUpdatedAt: timestamp('password_updated_at'),
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  // 服务端吊销版本号：登出/改密 +1，auth 中间件回查 DB 与 JWT payload 比对
  tokenVersion: integer('token_version').notNull().default(1),
  // 邮箱（PG 唯一但 NULL 不参与判定；与 iDO 同源，便于「撞邮箱」409 而非用户内重复）
  email: varchar('email', { length: 255 }),
  // UI 语言偏好：'zh-CN' | 'en-US'
  languagePreference: varchar('language_preference', { length: 16 }).notNull().default('zh-CN'),
  // 软删除时间戳：非 null 即账号已停用——禁止登录、不出现在用户目录中。
  // 硬删会被 automations/sprints/pipeline* 的 NOT NULL created_by FK 拒掉。
  disabledAt: timestamp('disabled_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  // 与 drizzle/0039 中「email 唯一」声明同源；drizzle-kit migrate 同步建索引
  emailUq: uniqueIndex('users_email_uq').on(t.email).where(sql`${t.email} IS NOT NULL`),
}));

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 200 }).notNull().unique(),
  // 自引用 FK：null = 根组织（租户根仅由种子迁移创建）
  parentId: uuid('parent_id').references((): AnyPgColumn => organizations.id, { onDelete: 'set null' }),
  // 物化路径 /orgId/orgId/（含自身，首尾都是 /）
  path: text('path').notNull().unique(),
  description: text('description'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const organizationMembers = pgTable('organization_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  isManager: boolean('is_manager').notNull().default(false),
  isUser: boolean('is_user').notNull().default(true),
  joinedAt: timestamp('joined_at').defaultNow().notNull(),
}, (t) => ({
  orgUserUq: unique('organization_members_org_user_uq').on(t.organizationId, t.userId),
}));

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  // 仓库元数据：与 iDO 同源（AI 生成用例步骤需要看代码）。当前只存元数据 + 验证可达性，
  // 后续接入 dispatch-gateway 的 github.service.ts 后才会有 clone / file read。
  repoUrl: text('repo_url'),
  defaultBranch: varchar('default_branch', { length: 200 }).notNull().default('main'),
  provider: varchar('provider', { length: 16 }).notNull().default('github'),
  gitlabUrlOverride: text('gitlab_url_override'),
  // 仓库 PAT：明文存盘仅为最小迁移代价；后续接 dispatch 时应改 encrypted column。
  // 现 read 路径全部 mask（projectsRoute / ProjectDetailPanel 都不得回传）。
  patOverride: text('pat_override'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// 项目分配：user ⇄ project 多对多。
// organizationId 是冗余快照，固定在「分配发生时项目所属的组织」——
// 后续即便项目被 moveProject 改到别的组织，assignment 仍指认当时分配到的组织身份，便于跨组织追溯。
export const projectAssignments = pgTable('project_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  assignedAt: timestamp('assigned_at').defaultNow().notNull(),
}, (t) => ({
  projectUserUq: unique('project_assignments_project_user_uq').on(t.projectId, t.userId),
  byUser: index('project_assignments_user_idx').on(t.userId),
  byOrg: index('project_assignments_org_idx').on(t.organizationId),
}));

export const groups = pgTable('groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 200 }).notNull(),
  defaultUrl: text('default_url'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// 项目版本：测试环境 / 用例 / 执行计划全部按版本工作；前端操作一律显式携带 versionId，无默认版本。
// ref / refKind 指向项目仓库的具体 git ref（branch 或 tag），给 AI 工作台 checkout 时精确定位。
export const projectVersions = pgTable('project_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 80 }).notNull(),
  description: text('description'),
  ref: varchar('ref', { length: 200 }),
  refKind: varchar('ref_kind', { length: 16 }),
  // 版本关联环境：空 → 执行期回退项目默认环境（test_environments.is_default）
  environmentId: uuid('environment_id').references(() => testEnvironments.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  projectNameUq: unique('project_versions_project_name_uq').on(t.projectId, t.name),
  projectIdIdx: index('project_versions_project_idx').on(t.projectId),
}));

export const executionPlans = pgTable('execution_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  versionId: uuid('version_id').references(() => projectVersions.id, { onDelete: 'set null' }),
  name: varchar('name', { length: 200 }).notNull(),
  environment: varchar('environment', { length: 100 }),
  environmentId: uuid('environment_id').references(() => testEnvironments.id, { onDelete: 'set null' }),
  strategy: varchar('strategy', { length: 20 }).notNull().default('run_all'),
  loginPrepareEnabled: boolean('login_prepare_enabled').notNull().default(false),
  loginCaseId: uuid('login_case_id').references(() => testCases.id, { onDelete: 'set null' }),
  detectionUrl: text('detection_url'),
  loginSuccessSelector: text('login_success_selector'),
  loginUnauthorizedKeywords: jsonb('login_unauthorized_keywords'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  versionIdIdx: index('execution_plans_version_idx').on(t.versionId),
}));

export const planCases = pgTable('plan_cases', {
  id: uuid('id').primaryKey().defaultRandom(),
  planId: uuid('plan_id').notNull().references(() => executionPlans.id, { onDelete: 'cascade' }),
  caseId: uuid('case_id').notNull().references(() => testCases.id, { onDelete: 'cascade' }),
  order: integer('order').notNull(),
});

export const planRuns = pgTable('plan_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  planId: uuid('plan_id').notNull().references(() => executionPlans.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  status: varchar('status', { length: 20 }).notNull(),
  strategy: varchar('strategy', { length: 20 }).notNull(),
  loginPrepareEnabled: boolean('login_prepare_enabled').notNull().default(false),
  loginCaseId: uuid('login_case_id').references(() => testCases.id, { onDelete: 'set null' }),
  detectionUrl: text('detection_url'),
  loginSuccessSelector: text('login_success_selector'),
  loginUnauthorizedKeywords: jsonb('login_unauthorized_keywords'),
  startedAt: timestamp('started_at').defaultNow().notNull(),
  finishedAt: timestamp('finished_at'),
  durationMs: integer('duration_ms'),
  summary: text('summary'),
  totalCases: integer('total_cases').notNull().default(0),
  passedCases: integer('passed_cases'),
  failedCases: integer('failed_cases'),
  skippedCases: integer('skipped_cases'),
  cancelRequested: boolean('cancel_requested').notNull().default(false),
});

export const planRunCases = pgTable('plan_run_cases', {
  id: uuid('id').primaryKey().defaultRandom(),
  planRunId: uuid('plan_run_id').notNull().references(() => planRuns.id, { onDelete: 'cascade' }),
  caseId: uuid('case_id').notNull().references(() => testCases.id, { onDelete: 'cascade' }),
  reportId: uuid('report_id').references(() => reports.id, { onDelete: 'set null' }),
  order: integer('order').notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  stepKind: varchar('step_kind', { length: 20 }).notNull(),
  startedAt: timestamp('started_at'),
  finishedAt: timestamp('finished_at'),
  durationMs: integer('duration_ms'),
  error: text('error'),
});

export const testAttachments = pgTable('test_attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id').notNull().references(() => testCases.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  stepId: uuid('step_id').references(() => testSteps.id, { onDelete: 'set null' }),
  originalName: text('original_name').notNull(),
  mime: text('mime'),
  size: integer('size').notNull(),
  sha256: varchar('sha256', { length: 64 }).notNull(),
  storedPath: text('stored_path').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  projectShaUq: unique('test_attachments_project_sha_uq').on(t.projectId, t.sha256),
}));

export const testSessions = pgTable('test_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id').notNull().references(() => testCases.id, { onDelete: 'cascade' }),
  mode: varchar('mode', { length: 16 }).notNull().default('fresh'),
  incognito: boolean('incognito').notNull().default(false),
  resumeFromOrder: integer('resume_from_order'),
  tabs: jsonb('tabs'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// 组织级标签：用例可贴/摘多个；同组织内 name 唯一，组织内全部项目共享可见。
export const tags = pgTable('tags', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 80 }).notNull(),
  // hex 颜色不含 `#`，例如 '34c759'
  color: varchar('color', { length: 16 }).notNull(),
  description: text('description'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  orgNameUq: unique('tags_org_name_uq').on(t.organizationId, t.name),
}));

// 用例 ↔ 标签 关联（case 删除或 tag 删除时 cascade 解除）
export const caseTags = pgTable('case_tags', {
  caseId: uuid('case_id').notNull().references(() => testCases.id, { onDelete: 'cascade' }),
  tagId: uuid('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
}, (t) => ({
  pk: primaryKey({ columns: [t.caseId, t.tagId] }),
}));

export const testEnvironments = pgTable('test_environments', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 120 }).notNull(),
  // 项目默认环境：未被 case/plan/version 显式指定环境时的兜底；项目内至多一个
  isDefault: boolean('is_default').notNull().default(false),
  // 部署入口 URL：执行期导航兜底（用例.url → 分组.defaultUrl → 环境.base_url → 项目.defaultUrl）
  baseUrl: text('base_url'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  projectNameUq: unique('test_environments_project_name_uq').on(t.projectId, t.name),
}));

// 环境对象：一个环境下的多类资源（db / syslog，未来可扩展），每类可多条、有唯一默认。
// 秘密（db 密码 / syslog SSH 私钥）以 { c, i, t } base64 三元组存于 payload.secret，AES-256-GCM。
export const environmentObjects = pgTable('environment_objects', {
  id: uuid('id').primaryKey().defaultRandom(),
  environmentId: uuid('environment_id').notNull().references(() => testEnvironments.id, { onDelete: 'cascade' }),
  objectType: varchar('object_type', { length: 32 }).notNull(),
  label: varchar('label', { length: 120 }).notNull().default('默认'),
  payload: jsonb('payload').notNull().default({}),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  envIdx: index('environment_objects_env_idx').on(t.environmentId),
}));
