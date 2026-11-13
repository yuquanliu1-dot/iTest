import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  jsonb,
  timestamp,
  boolean,
  bigserial,
  unique,
  primaryKey,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { StepAction, Locator } from '@itest/shared';

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
  /** Web service object identity bound to the case (environment_objects objectType='web' payload.name);
   *  empty = use the environment's default web service. At execution time it is joined with the relative url into an absolute address. */
  webServiceRef: varchar('web_service_ref', { length: 64 }),
  /** Requirement number (free-text external number, not a requirements FK — the user numbering system lives in an external system).
   *  Filled/cleared manually in the case detail; during AI generation it is carried down verbatim from the prompt via stage_case.requirementNo. */
  requirementNo: varchar('requirement_no', { length: 64 }),
  title: varchar('title', { length: 200 }).notNull(),
  description: text('description'),
  priority: varchar('priority', { length: 20 }).notNull().default('P1'),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  windowStrategy: varchar('window_strategy', { length: 16 }).notNull().default('maximize'),
  windowWidth: integer('window_width'),
  windowHeight: integer('window_height'),
  incognito: boolean('incognito').notNull().default(false),
  defaultEnvId: uuid('default_env_id').references(() => testEnvironments.id, { onDelete: 'set null' }),
  datasetId: uuid('dataset_id').references(() => datasets.id, { onDelete: 'set null' }),
  /** Dataset row selection: array of enabled-row indexes (0-based, renumbered after disabled rows are removed, same space as loadDatasetForRun).
   *  [] = all enabled rows (= old behavior, no data backfill needed). Non-empty = run only these rows.
   *  Cleared on dataset switch / unbind / dataset deletion (see updateCase / deleteDataset). */
  datasetRowIndexes: integer('dataset_row_indexes').array().notNull().default([]),
  scenarioId: uuid('scenario_id').references(() => scenarios.id, { onDelete: 'set null' }),
  /** Case-level expected description (natural language). At the end of the replay phase, the vision LLM judges the final state from the final screenshot + this field;
   *  when empty/null, the case-level assertion is skipped (pass/fail judged only by whether all step.action succeed). */
  expectedOutcome: text('expected_outcome'),
  /** Coverage types of this case (subset of COVERAGE_TYPE_KEYS). Carried down from stage_case.coverageTypes during AI generation:
   *  once persisted, coverage becomes queryable/countable instead of just a sentence in the prompt. */
  coverageTypes: jsonb('coverage_types').default([]),
  // Mobile metadata: platform='web' means legacy web cases; 'android'|'ios' means the Appium driver.
  // Reuses the test_cases dataset_id / default_env_id "nullable FK + set null" convention: deleting device_targets must not cascade into cases.
  platform: varchar('platform', { length: 16 }).notNull().default('web'),
  mobileOs: varchar('mobile_os', { length: 16 }),
  mobileDeviceTargetId: uuid('mobile_device_target_id').references(() => deviceTargets.id, { onDelete: 'set null' }),
  appRef: jsonb('app_ref').$type<AppRef | null>(),
  /** Creator (aligned with the plan_schedules.created_by_user_id convention); set to NULL on user deletion, cases unaffected */
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  versionIdIdx: index('test_cases_version_idx').on(t.versionId),
  groupIdIdx: index('idx_test_cases_group').on(t.groupId),
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
  /** Since 2026-10-15 only 'version' is in use: requirement-level threads (kind='requirement') and their companion
   *  ai_workspace_state / ai_scenarios / ai_cases tables were removed with the dead-code cleanup (all empty tables in production).
   *  The default stays 'requirement' rather than changing to 'version' — changing the default brings no benefit to existing version rows,
   *  while forcing every code reader to re-confirm "which thread kind is actually alive".
   *  New threads always pass kind: 'version' explicitly (see session.ts ensureSpaceRecord). */
  kind: varchar('kind', { length: 20 }).notNull().default('requirement'),
  // requirement threads are 1:1 with requirements; NULL for version threads (Postgres unique index doesn't constrain NULL, multiple version threads are legal)
  requirementId: uuid('requirement_id').references(() => requirements.id, { onDelete: 'cascade' }),
  versionId: uuid('version_id').references(() => projectVersions.id, { onDelete: 'cascade' }),
  title: text('title'),
  piThreadId: text('pi_thread_id').notNull(),
  /** Thread purpose: 'chat' user conversation (default); 'rca' background thread for plan-run failure root-cause analysis */
  purpose: varchar('purpose', { length: 20 }).notNull().default('chat'),
  /** The plan_run associated when purpose='rca'; NULL for chat threads (no FK, same precedent as schedule_id) */
  planRunId: uuid('plan_run_id'),
  /** Thread creator: AI-created objects (env/plan/...) use it as their owner */
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  requirementUq: uniqueIndex('ai_threads_requirement_uq').on(t.requirementId),
  versionIdx: index('ai_threads_version_idx').on(t.versionId),
}));

// Scoped by version thread: the AI writes here via stage_* tools, the frontend StagePanel checks rows → /stage/save persists to the real tables.
// The space assistant has no requirementId (requirements are typed by the user directly in dialogs/assistant, not stored in the requirements table); localId is generated by the LLM.
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
    /** Requirement number extracted verbatim from the user prompt by the AI (e.g. REQ-2024-001); saved to test_cases.requirement_no along with the case */
    requirementNo: varchar('requirement_no', { length: 64 }),
    steps: jsonb('steps').notNull().default([]),
    defaultEnvId: uuid('default_env_id'),
    expectedOutcome: text('expected_outcome'),
    /** Companion binding: localId of the dataset staged in the same batch (generated by stage_dataset); at save time the dataset is persisted first, then the real datasetId is backfilled. */
    datasetLocalId: text('dataset_local_id'),
    /** Coverage types of this case (functional/exception/boundary/security/uiux).
     *  Coverage requirements checked in the dialog used to be just a sentence concatenated into the prompt — invisible to the tool layer, unverifiable after generation;
     *  landing in this column turns the coverage intent into queryable data: the staging area can display it and a coverage matrix can be built later. */
    coverageTypes: jsonb('coverage_types').default([]),
    stagedAt: timestamp('staged_at').defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.threadId, t.localId] }),
    versionIdx: index('ai_stage_cases_version_idx').on(t.versionId),
  }),
);

/** Version space assistant "modify existing case/step" staging table.
 *  Backs the stage_case_op tool (single tool, multiple actions). PK = (threadId, localId), same style as stage_cases.
 *  - op:update_case/delete_case/move_case/update_step/insert_step/delete_step/move_step
 *  - payload:zod-validated concrete op input (patch, targetGroupId, stepId, order, compiled, instruction…)
 *  - summary: one-line row description rendered by the frontend StagePanel
 *  - diff: comparison with the original value (filled for update_case/move_case/update_step/move_step; not filled for delete_*)
 *  The user checks rows in StagePanel → POST /threads/:id/stage/save persists everything in one shot (order: cases→scenarios→environments→plans→caseOps).
 */
export const aiStageCaseOps = pgTable(
  'ai_stage_case_ops',
  {
    threadId: text('thread_id').notNull(),
    localId: text('local_id').notNull(),
    versionId: uuid('version_id').notNull(),
    caseId: uuid('case_id').notNull(),
    op: varchar('op', { length: 30 }).notNull(),
    payload: jsonb('payload').notNull(),
    summary: text('summary').notNull(),
    diff: text('diff'),
    stagedAt: timestamp('staged_at').defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.threadId, t.localId] }),
    versionIdx: index('ai_stage_case_ops_version_idx').on(t.versionId),
    caseIdx: index('ai_stage_case_ops_case_idx').on(t.caseId),
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

/** Version space assistant "dataset staging table". Backs the stage_dataset tool; PK = (threadId, localId).
 *  rows are plaintext drafts (AI-generated, visible in the StagePanel preview); sensitive cells are encrypted only when
 *  /stage/save runs createDataset(normalizeDataset); the stage table never stores ciphertext. */
export const aiStageDatasets = pgTable(
  'ai_stage_datasets',
  {
    threadId: text('thread_id').notNull(),
    localId: text('local_id').notNull(),
    versionId: uuid('version_id').notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    description: text('description'),
    columns: jsonb('columns').notNull().default([]),
    rows: jsonb('rows').notNull().default([]),
    stagedAt: timestamp('staged_at').defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.threadId, t.localId] }),
    versionIdx: index('ai_stage_datasets_version_idx').on(t.versionId),
  }),
);

export const testSteps = pgTable('test_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id').references(() => testCases.id, { onDelete: 'cascade' }).notNull(),
  order: integer('order').notNull(),
  // Fully removed since 2026-10-06: the name column (old UI short title) was retired like the action column;
  //   short titles + row-level natural language are both carried by the instruction column. DB columns dropped, schema synced accordingly.
  delayMs: integer('delay_ms'),
  source: varchar('source', { length: 20 }).notNull(),
  tabRef: varchar('tab_ref', { length: 64 }),
  sensitive: boolean('sensitive').notNull().default(false),
  componentKind: varchar('component_kind', { length: 32 }),
  secretCiphertext: text('secret_ciphertext'),
  secretIv: text('secret_iv'),
  secretTag: text('secret_tag'),
  /** Row-level natural language description (for humans / as the LLM's starting point). Not read during replay; the UI summary prefers compiled[0].
   *  Replaces the old name column since 2026-10-07; the full natural language description lands here. */
  instruction: text('instruction'),
  /** Executable DSL array; the sole basis for replay.
   *  Empty array/null = not compiled; the dispatcher throws `compile-missing` and the UI blocks execution, prompting "AI compile".
   *  Typed as unknown[]: after zod parsing at the route layer each entry is already a StepAction; kept wide here to avoid narrowing the route input. */
  compiled: jsonb('compiled').$type<unknown[]>(),
  assertion: jsonb('assertion'),
  // Mobile-only: when a step overrides mobile_os (consistent with the case's platform), replay dispatches by android/ios.
  // Default = follow the case's platform (steps of web cases are always null).
  mobileOs: varchar('mobile_os', { length: 16 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  caseIdIdx: index('idx_test_steps_case').on(t.caseId),
}));

/** Runtime action cache for aiTask vision steps ("automatic solidification"): after the first successful replay, the action sequence
 *  the AI actually executed is cached; subsequent replays execute the cache mechanically first, silently falling back to AI and overwriting on failure (self-heal protocol).
 *  Complements solidify_case: the cache is zero-intrusion to the case definition (test_steps.compiled unchanged).
 *  key = (stepId, exact instruction match) — any instruction change invalidates it; step deletion cascades the cache clear. */
export const stepActionCache = pgTable('step_action_cache', {
  stepId: uuid('step_id').primaryKey().references(() => testSteps.id, { onDelete: 'cascade' }),
  instruction: text('instruction').notNull(),
  actions: jsonb('actions').$type<StepAction[]>().notNull(),
  hits: integer('hits').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/** Mechanical step locator repair memory: after an AI fallback (ai_fallback_locator_failed) full-step redo succeeds,
 *  the stable selector resolved back from the AI actions (sanitized via mapSelectorStrict) is cached by step_id;
 *  subsequent replays append the cached locator at the end of the candidate chain to join probing — passing with zero LLM hits;
 *  if the cache also fails → AI fallback as before → overwrite the cache (self-heal protocol). Zero intrusion into test_steps.compiled.
 *  key = stepId (action_kind distinguishes multiple actions within a step); step deletion cascades the cache clear. */
export const stepLocatorCache = pgTable('step_locator_cache', {
  stepId: uuid('step_id').primaryKey().references(() => testSteps.id, { onDelete: 'cascade' }),
  actionKind: varchar('action_kind', { length: 16 }).notNull(),
  locator: jsonb('locator').$type<Locator>().notNull(),
  hits: integer('hits').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const reports = pgTable('reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id').references(() => testCases.id, { onDelete: 'cascade' }).notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  durationMs: integer('duration_ms'),
  stepResults: jsonb('step_results').notNull(),
  preflight: jsonb('preflight'),
  summary: text('summary'),
  datasetRowIndex: integer('dataset_row_index'),
  datasetSnapshot: jsonb('dataset_snapshot'),
  // Batch id of one dataset execution: shared by all rows of a single runCase call (no FK, pure grouping key).
  // The report detail page uses it to fetch "sibling rows of the same batch" for the row switcher; null on old reports (switcher not rendered).
  datasetBatchId: uuid('dataset_batch_id'),
  // Mobile snapshot: the final resolved device_target value at execution time goes into the report for historical traceability.
  // deviceName takes device_target.name's value at that moment (renaming a device_target does not retroactively affect historical reports).
  platform: varchar('platform', { length: 16 }).notNull().default('web'),
  mobileOs: varchar('mobile_os', { length: 16 }),
  deviceName: varchar('device_name', { length: 128 }),
  deviceTargetId: uuid('device_target_id').references(() => deviceTargets.id, { onDelete: 'set null' }),
  // Double pass-rate convention: passed with healed=true = passed via self-heal (aiTask cache diverged and the AI fallback succeeded);
  // passed with healed=false = passed on first attempt; failed is always false.
  healed: boolean('healed').notNull().default(false),
  /** Creator = the person who triggered execution (single case = requesting user; plan runs reuse plan_runs.triggered_by_user_id) */
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  // Real execution phase start/end moments: started_at = when steps began running (after environment/URL resolution, same baseline as duration_ms);
  // finished_at = when the terminal state was persisted. Both columns are null on old reports (nullable, not backfilled).
  // Distinguish from created_at: created_at is when the report row was inserted, including queueing + environment resolution + dataset decryption time.
  startedAt: timestamp('started_at'),
  finishedAt: timestamp('finished_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  caseCreatedIdx: index('idx_reports_case_created').on(t.caseId, t.createdAt),
  batchIdx: index('idx_reports_dataset_batch').on(t.datasetBatchId),
}));

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: varchar('username', { length: 50 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: varchar('display_name', { length: 100 }).notNull(),
  // null means the password has never been changed (works with must_change_password to force a change on first login)
  passwordUpdatedAt: timestamp('password_updated_at'),
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  // Server-side revision counter: +1 on logout/password change; the auth middleware re-checks the DB and compares with the JWT payload
  tokenVersion: integer('token_version').notNull().default(1),
  // Email (unique in PG but NULL excluded from the check; same-origin with iDO so "email collision" yields 409 rather than intra-user duplication)
  email: varchar('email', { length: 255 }),
  // UI language preference: 'zh-CN' | 'en-US'
  languagePreference: varchar('language_preference', { length: 16 }).notNull().default('zh-CN'),
  // Soft-delete timestamp: non-null means the account is deactivated — login forbidden and excluded from the user directory.
  // Hard delete would be rejected by the NOT NULL created_by FKs of automations/sprints/pipeline*.
  disabledAt: timestamp('disabled_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  // Same origin as the "email unique" declaration in drizzle/0017; drizzle-kit migrate creates the index in sync
  emailUq: uniqueIndex('users_email_uq').on(t.email).where(sql`${t.email} IS NOT NULL`),
}));

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 200 }).notNull().unique(),
  // Self-referencing FK: null = root organization (tenant roots are created only by seed migrations)
  parentId: uuid('parent_id').references((): AnyPgColumn => organizations.id, { onDelete: 'set null' }),
  // Materialized path /orgId/orgId/ (includes itself, leading and trailing /)
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

/**
 * Product line: a container layer under an organization grouping a "baseline project" together with "multiple site projects".
 * Its purpose is cross-project case sharing — within the same product line, execution plans can reference each other's cases.
 *
 * No separate membership table for visibility: a product line hangs under the organization and is automatically visible per the organization's visibleOrgIdsFor convention.
 */
export const productLines = pgTable('product_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  /** Creator (aligned with the projects.created_by_user_id convention) */
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  orgNameUq: unique('product_lines_org_name_uq').on(t.organizationId, t.name),
}));

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Projects have no organization column of their own: the owning organization always equals its product line's organization (a structural invariant, not app-layer sync).
  // So moving a product line only needs UPDATE product_lines.organization_id and its projects switch organizations automatically.
  // notNull + onDelete restrict: when deleting a line that still has projects, the D1 semantics are intercepted first by the app layer's 409 line_not_empty;
  // the FK is the fallback — deleting a line must not silently orphan its projects into "no organization, no product line".
  productLineId: uuid('product_line_id').notNull().references(() => productLines.id, { onDelete: 'restrict' }),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  // Repo metadata: same origin as iDO (AI case-step generation needs to see code). Currently stores metadata + verified reachability only;
  // clone / file read will only exist after wiring in dispatch-gateway's github.service.ts.
  repoUrl: text('repo_url'),
  defaultBranch: varchar('default_branch', { length: 200 }).notNull().default('main'),
  provider: varchar('provider', { length: 16 }).notNull().default('github'),
  gitlabUrlOverride: text('gitlab_url_override'),
  // Repo PAT: plaintext storage is only the minimal migration cost; should become an encrypted column when dispatch is wired in.
  // All read paths currently mask it (projectsRoute / ProjectDetailPanel must never return it).
  patOverride: text('pat_override'),
  /** Creator (aligned with the plan_schedules.created_by_user_id convention) */
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Project assignment: user ⇄ project many-to-many.
// organizationId is the organization snapshot "at assignment time", purely for audit: projects themselves no longer have an organization column,
// visibility is always derived via project → product_lines.organization_id; this column is no longer read as a gate.
// (Before R2 it was one of the visibility gates, so it was rewritten in sync on move/mount; after R2 that sync is unnecessary.)
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
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Project versions: environments / cases / execution plans all work per version; frontend operations always carry versionId explicitly, no default version.
// ref / refKind point to a concrete git ref (branch or tag) of the project repo, giving the AI workbench a precise checkout target.
export const projectVersions = pgTable('project_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 80 }).notNull(),
  description: text('description'),
  ref: varchar('ref', { length: 200 }),
  refKind: varchar('ref_kind', { length: 16 }),
  // Version-linked environment: empty → fall back to the project default environment at execution time (test_environments.is_default)
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
  strategy: varchar('strategy', { length: 20 }).notNull().default('run_all'),
  /** Automatically run AI root-cause analysis on failed cases after the run (snapshotted into planRuns) */
  rcaEnabled: boolean('rca_enabled').notNull().default(false),
  /** Creator (aligned with the plan_schedules.created_by_user_id convention) */
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  versionIdIdx: index('execution_plans_version_idx').on(t.versionId),
}));

/** Execution groups: ordered grouping of a plan's cases, each group independently configured with environment/login preparation/in-group fail_fast/device and browser context.
 *  Groups run serially by order; the plan-level strategy governs inter-group failure propagation (fail_fast = a failed group cancels subsequent groups). */
export const planCaseGroups = pgTable('plan_case_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  planId: uuid('plan_id').notNull().references(() => executionPlans.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 200 }).notNull(),
  order: integer('order').notNull(),
  environmentId: uuid('environment_id').references(() => testEnvironments.id, { onDelete: 'set null' }),
  loginPrepareEnabled: boolean('login_prepare_enabled').notNull().default(false),
  loginCaseId: uuid('login_case_id').references(() => testCases.id, { onDelete: 'set null' }),
  detectionUrl: text('detection_url'),
  loginSuccessSelector: text('login_success_selector'),
  loginUnauthorizedKeywords: jsonb('login_unauthorized_keywords'),
  /** In-group policy: skip the group's remaining cases after the first failure (plan-level strategy governs between groups) */
  failFast: boolean('fail_fast').notNull().default(false),
  /** Login-case dataset row override (three states, same semantics as plan_cases.dataset_row_indexes):
   *  null = follow the case-level setting; [] = all enabled rows; non-empty = subset. Only effective when login_case_id points to a case bound to a dataset. */
  loginDatasetRowIndexes: integer('login_dataset_row_indexes').array(),
  /** Effective uniformly at group level: deviceTargetId / browser context (same shape as plan_cases.target_override) */
  targetConfig: jsonb('target_config').$type<{ deviceTargetId?: string; browserContext?: 'incognito' | 'persistent' } | null>(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  planOrderIdx: index('idx_plan_case_groups_plan_order').on(t.planId, t.order),
}));

export const planCases = pgTable('plan_cases', {
  id: uuid('id').primaryKey().defaultRandom(),
  planId: uuid('plan_id').notNull().references(() => executionPlans.id, { onDelete: 'cascade' }),
  caseId: uuid('case_id').notNull().references(() => testCases.id, { onDelete: 'cascade' }),
  groupId: uuid('group_id').notNull().references(() => planCaseGroups.id, { onDelete: 'cascade' }),
  order: integer('order').notNull(),
  // Plan-level override: the case's default device_target / browser context can be rewritten when "adding to the plan",
  // without touching the case itself; resolved per the override only for this plan execution. null = use the case's own value.
  targetOverride: jsonb('target_override').$type<{ deviceTargetId?: string; browserContext?: 'incognito' | 'persistent' } | null>(),
  // Plan-level dataset row selection (three-state override): null = follow the case-level config (execution falls back to test_cases.dataset_row_indexes);
  // [] = all enabled rows; non-empty = subset of enabled-row indexes (same numbering space as the case level). Same case across groups = multiple rows, each independent.
  datasetRowIndexes: integer('dataset_row_indexes').array(),
}, (t) => ({
  planOrderIdx: index('idx_plan_cases_plan_order').on(t.planId, t.order),
}));

export const planRuns = pgTable('plan_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  planId: uuid('plan_id').notNull().references(() => executionPlans.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  status: varchar('status', { length: 20 }).notNull(),
  strategy: varchar('strategy', { length: 20 }).notNull(),
  /** Group structure snapshot (written at enqueue time): [{id,name,order,environmentId,loginPrepareEnabled,loginCaseId,detectionUrl,loginSuccessSelector,loginUnauthorizedKeywords,failFast,targetConfig}].
   *  null on old runs (the engine falls back to synthesizing a single group). Scalar login_* columns kept for old runs; new runs also write them, OR'd for old-UI compatibility. */
  groups: jsonb('groups'),
  loginPrepareEnabled: boolean('login_prepare_enabled').notNull().default(false),
  loginCaseId: uuid('login_case_id').references(() => testCases.id, { onDelete: 'set null' }),
  detectionUrl: text('detection_url'),
  loginSuccessSelector: text('login_success_selector'),
  loginUnauthorizedKeywords: jsonb('login_unauthorized_keywords'),
  rcaEnabled: boolean('rca_enabled').notNull().default(false),
  startedAt: timestamp('started_at').defaultNow().notNull(),
  finishedAt: timestamp('finished_at'),
  durationMs: integer('duration_ms'),
  summary: text('summary'),
  totalCases: integer('total_cases').notNull().default(0),
  passedCases: integer('passed_cases'),
  failedCases: integer('failed_cases'),
  skippedCases: integer('skipped_cases'),
  cancelRequested: boolean('cancel_requested').notNull().default(false),
  /** Trigger source: `manual` one-click execution / `schedule` scheduler trigger */
  triggeredBy: varchar('triggered_by', { length: 20 }).notNull().default('manual'),
  /** Actor of a scheduled run (the user who created the schedule); the initiator for manual runs */
  triggeredByUserId: uuid('triggered_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  /** Associated schedule record; null for manual */
  scheduleId: uuid('schedule_id'),
}, (t) => ({
  projectStartedIdx: index('idx_plan_runs_project_started').on(t.projectId, t.startedAt),
  planStartedIdx: index('idx_plan_runs_plan_started').on(t.planId, t.startedAt),
}));

export const planRunCases = pgTable('plan_run_cases', {
  id: uuid('id').primaryKey().defaultRandom(),
  planRunId: uuid('plan_run_id').notNull().references(() => planRuns.id, { onDelete: 'cascade' }),
  caseId: uuid('case_id').notNull().references(() => testCases.id, { onDelete: 'cascade' }),
  reportId: uuid('report_id').references(() => reports.id, { onDelete: 'set null' }),
  /** Dataset iterations: list of report ids produced by all data rows of this case (first element matches reportId, for legacy reads). */
  reportIds: jsonb('report_ids').$type<string[]>(),
  groupId: uuid('group_id'),
  groupName: varchar('group_name', { length: 200 }),
  groupOrder: integer('group_order'),
  order: integer('order').notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  stepKind: varchar('step_kind', { length: 20 }).notNull(),
  startedAt: timestamp('started_at'),
  finishedAt: timestamp('finished_at'),
  durationMs: integer('duration_ms'),
  error: text('error'),
  /** AI root-cause analysis result (written by the save_rca_result tool; the worker's timeout fallback writes timeout) */
  rca: jsonb('rca'),
}, (t) => ({
  runOrderIdx: index('idx_plan_run_cases_run_order').on(t.planRunId, t.order),
  caseIdx: index('idx_plan_run_cases_case').on(t.caseId),
  reportIdx: index('idx_plan_run_cases_report').on(t.reportId),
}));

/**
 * Execution plan scheduling: cron expressions repeat execution at fixed times.
 * "Run now" reuses the existing "one-click execution" button; only cron remains as a trigger mode (aligned with iDO Automation).
 *
 * At process startup BullMQ's reconcileAllSchedules() enqueues everything with enabled=true;
 * cron + next execution time are persisted here, and the UI list reads next_run_at from here.
 */
export const planSchedules = pgTable('plan_schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  planId: uuid('plan_id').notNull().references(() => executionPlans.id, { onDelete: 'cascade' }),
  /** Can be temporarily disabled by the user (no need to delete the schedule); worker / routes read enabled to decide whether to enqueue */
  enabled: boolean('enabled').notNull().default(true),
  /** cron expression (e.g. '0 9 * * 1-5') */
  cronExpr: varchar('cron_expr', { length: 120 }).notNull(),
  /** IANA timezone name, default Asia/Shanghai */
  timezone: varchar('timezone', { length: 64 }).notNull().default('Asia/Shanghai'),
  /** Most recent actual trigger time (written by the worker) */
  lastRunAt: timestamp('last_run_at'),
  /** Next trigger time (written by the worker; the list page's "next execution" reads this column) */
  nextRunAt: timestamp('next_run_at'),
  /** Creator; a scheduled run's triggered_by_user_id reuses this value */
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  planIdIdx: index('plan_schedules_plan_idx').on(t.planId),
}));

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

// Organization-level tags: cases can attach/remove multiple; name is unique within an organization, shared and visible across all projects in it.
export const tags = pgTable('tags', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 80 }).notNull(),
  // hex color without `#`, e.g. '34c759'
  color: varchar('color', { length: 16 }).notNull(),
  description: text('description'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  orgNameUq: unique('tags_org_name_uq').on(t.organizationId, t.name),
}));

// case ↔ tag association (cascade-removed when the case or tag is deleted)
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
  // Project default environment: the fallback when no environment is explicitly specified by case/plan/version; at most one per project
  isDefault: boolean('is_default').notNull().default(false),
  /** Creator (aligned with the plan_schedules.created_by_user_id convention) */
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  projectNameUq: unique('test_environments_project_name_uq').on(t.projectId, t.name),
}));

/** Dataset column definition: name is the replay variable name ({{name}}); sensitive marks the whole column as encrypted. */
export interface DatasetColumn {
  name: string;
  sensitive: boolean;
}
/** Sensitive-cell ciphertext: AES-256-GCM triple (isomorphic to environment_objects payload.secret). */
export interface DatasetEncCell { c: string; i: string; t: string }
export interface DatasetRow {
  disabled: boolean;
  cells: Record<string, string | DatasetEncCell>;
}

/** Mobile app reference: bundleId / local app path / launch args.
 *  Lands in test_cases.app_ref; at replay the driver uses it to launch the app + upload derived capabilities (activity / package). */
export interface AppRef {
  bundleId: string;
  appPath?: string;
  launchArgs?: string[];
}

// Device target: each record represents a concrete real device/emulator, hung under a project; both cases and execution plans resolve via device_target.
// Peer of test_environments but with a different purpose: environments manage baseUrl; device_target manages mobile_os + device_ref + app_ref.
export const deviceTargets = pgTable('device_targets', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 128 }).notNull(),
  mobileOs: varchar('mobile_os', { length: 16 }).notNull(),
  deviceRef: varchar('device_ref', { length: 128 }).notNull(),
  appBundleId: varchar('app_bundle_id', { length: 256 }),
  appPath: text('app_path'),
  launchArgs: jsonb('launch_args').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  uniqByProjectName: uniqueIndex('device_targets_project_name_uq').on(t.projectId, t.name),
}));

export const datasets = pgTable('datasets', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 120 }).notNull(),
  description: text('description'),
  columns: jsonb('columns').$type<DatasetColumn[]>().notNull().default([]),
  rows: jsonb('rows').$type<DatasetRow[]>().notNull().default([]),
  /** Creator (aligned with the plan_schedules.created_by_user_id convention) */
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  projectNameUq: unique('datasets_project_name_uq').on(t.projectId, t.name),
}));

// Environment objects: multiple resource kinds under one environment (db / syslog, extensible later), each kind can have multiple entries with a unique default.
// Secrets (db password / syslog SSH private key) are stored in payload.secret as the { c, i, t } base64 triple, AES-256-GCM.
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

// ── AI assistant Skills S1: resident process/knowledge guides (DB-driven, hot-effective for new threads) ──
// scope precedence: version > project > global (ordered at load time, see pi/space/guides.ts loadActiveGuides).
export const assistantGuides = pgTable('assistant_guides', {
  id: uuid('id').primaryKey().defaultRandom(),
  scope: varchar('scope', { length: 16 }).notNull(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  versionId: uuid('version_id').references(() => projectVersions.id, { onDelete: 'cascade' }),
  kind: varchar('kind', { length: 16 }).notNull(),
  body: text('body').notNull(),
  lang: varchar('lang', { length: 8 }).notNull().default('any'),
  sort: integer('sort').notNull().default(0),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  enabledIdx: index('assistant_guides_enabled_idx').on(t.scope, t.enabled),
}));

// ── AI assistant MCP general channel (DB config; loaded by registerMcpServer at session creation) ──
export const assistantMcpServers = pgTable('assistant_mcp_servers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 120 }).notNull(),
  kind: varchar('kind', { length: 8 }).notNull().default('stdio'),
  command: text('command'),
  args: jsonb('args').$type<string[]>(),
  url: text('url'),
  env: jsonb('env').$type<Record<string, string>>(),
  exposure: varchar('exposure', { length: 12 }).notNull().default('codemode'),
  scope: varchar('scope', { length: 16 }).notNull().default('global'),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  versionId: uuid('version_id').references(() => projectVersions.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  nameUq: unique('assistant_mcp_servers_name_uq').on(t.name),
  enabledIdx: index('assistant_mcp_servers_enabled_idx').on(t.enabled),
}));

// ── AI assistant Skills global shared store (all space threads load all enabled skills; managed on the system settings page) ──
// name is the skill slug, used as the .data/skills/<name>/ directory name and as read_skill/run_skill_script input.
// This table stores metadata only: the skill body and the whole directory tree live on disk under SKILLS_ROOT/<name>/ (the .data volume is shared across api replicas),
// hence no body/scripts columns — dropped in sync via drizzle-kit push during the 2026-10-19 storage flip.
export const assistantSkills = pgTable('assistant_skills', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 120 }).notNull(),
  description: varchar('description', { length: 500 }).notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  nameUq: unique('assistant_skills_name_uq').on(t.name),
  enabledIdx: index('assistant_skills_enabled_idx').on(t.enabled),
}));

// ── AI assistant short-term memory (product-line level, modeled on Claude Code auto-memory: index resident + body read on demand) ──
// Write = the model's save_memory tool (upserts the active row with the same title); read = system prompt
// index section + read_memory tool. status keeps soft-delete/retirement auditable; all read paths only take active.
// Reserved for R3: retired_by_batch (solidification batch); reserved for R5: hit_count/last_hit_at (read_memory instrumentation).
export const assistantMemories = pgTable('assistant_memories', {
  id: uuid('id').primaryKey().defaultRandom(),
  scope: varchar('scope', { length: 16 }).notNull(),
  productLineId: uuid('product_line_id').references(() => productLines.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 120 }).notNull(),
  hook: varchar('hook', { length: 200 }).notNull(),
  body: text('body'),
  provenance: varchar('provenance', { length: 16 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  retiredByBatch: uuid('retired_by_batch'),
  sourceThreadId: uuid('source_thread_id'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  hitCount: integer('hit_count').notNull().default(0),
  lastHitAt: timestamp('last_hit_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  activeIdx: index('assistant_memories_active_idx').on(t.scope, t.productLineId, t.status),
}));

// ── AI assistant trajectory store (product-line level, R2: procedural-memory exemplars of successful case-generation trajectories) ──
// Write = stage/save persistence hook → worker reads the pi-sessions JSONL to verify the criteria (verify_case
// toolResult isError=false), then an LLM distills it into the store; read = system prompt index section +
// search_trajectories tool. No global tier: trajectories contain anchor/URL details specific to a line — cross-line leakage
// is an incident. partial unique: one active trajectory per case, DB-level guard against duplicate distillation (R1 race lesson).
// Reserved for R3: retired_by_batch; reserved for R5: hit_count/last_hit_at (search instrumentation).
export const assistantTrajectories = pgTable('assistant_trajectories', {
  id: uuid('id').primaryKey().defaultRandom(),
  productLineId: uuid('product_line_id').notNull().references(() => productLines.id, { onDelete: 'cascade' }),
  taskTitle: varchar('task_title', { length: 200 }).notNull(),
  taskKeywords: text('task_keywords').notNull(),
  digest: text('digest').notNull(),
  caseTitle: varchar('case_title', { length: 200 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  retiredByBatch: uuid('retired_by_batch'),
  sourceThreadId: uuid('source_thread_id'),
  sourceCaseId: uuid('source_case_id'),
  sourceProjectId: uuid('source_project_id'),
  sourceVersionId: uuid('source_version_id'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  distillModel: varchar('distill_model', { length: 64 }).notNull(),
  hitCount: integer('hit_count').notNull().default(0),
  lastHitAt: timestamp('last_hit_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  lineIdx: index('assistant_trajectories_line_idx').on(t.productLineId, t.status),
  caseUq: uniqueIndex('assistant_trajectories_case_uq').on(t.sourceCaseId).where(sql`status = 'active'`),
}));

// ── R3 prompt editability: module value store (append-only version chain) ──
// Code is the module registry (promptModules.ts), DB is the value store: no row = code default (clearing the DB resets to factory);
// value=NULL = "follow the code default" (an explicit restore-to-default; values evolve with releases); current value = per module_key
// take the row with max seq; rollback = copy-append a historical row's value as a new row (rollback also leaves a trail and can be rolled back again).
// partial unique: repeated application of the same solidification proposal lands only one row (idempotency anchor); NULL manual rows are unconstrained.
export const assistantPromptModuleVersions = pgTable('assistant_prompt_module_versions', {
  seq: bigserial('seq', { mode: 'number' }).primaryKey(),
  moduleKey: varchar('module_key', { length: 100 }).notNull(),
  value: text('value'),
  source: varchar('source', { length: 20 }).notNull(),
  sourceRef: uuid('source_ref'),
  // Fingerprint (sha256) of the "code default baseline" when the row was written: which baseline version the override was based on.
  // Not equal to the current code default fingerprint = the baseline has changed and the override is out of sync (the criterion for drift alerts).
  // NULL = a row written by an older version, no fingerprint → status unknown (drift can't be judged, but it isn't hidden).
  baseHash: text('base_hash'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  keySeqIdx: index('assistant_prompt_module_versions_key_seq_idx').on(t.moduleKey, t.seq),
  sourceRefUq: uniqueIndex('assistant_prompt_module_versions_source_ref_uq').on(t.sourceRef).where(sql`${t.sourceRef} is not null`),
}));

// ── R3 solidification pipeline: inventory batches ──
// Low-frequency manual action: inline fire-and-forget (same as R2 trajectoryQueue), no BullMQ.
// Re-triggering while status=running → 409 re-entry guard.
export const assistantSolidifyBatches = pgTable('assistant_solidify_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  status: varchar('status', { length: 16 }).notNull(),
  inputSummary: text('input_summary'),
  error: text('error'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ── R3 solidification pipeline: solidification proposals ──
// The LLM only produces proposals and never touches assets; application always goes through human approval. prompt_amendment's body = incremental text
// appended into the module value; skill_revision's body = the revised full body (without frontmatter).
// Partial failure: apply_error records the reason + status returns to pending and can be retried (the idempotency trio makes retries safe).
export interface AssistantSolidifyProposalSource {
  type: 'memory' | 'trajectory' | 'lesson';
  id: string;
  title: string;
  /** Source line name (fixed at creation, 'global'=global memory). Lesson sources use an empty string (the UI renders an attribution badge instead). */
  lineName: string;
  /** Server-determined value (LLM output not trusted): memory=true / trajectory=false / lesson=false (a lesson auto-resolves on apply, no retirement checkbox). */
  retireRecommended: boolean;
  /** lesson only: attribution and signal count snapshot (shown in the approval detail). */
  attribution?: 'prompt' | 'step_description';
  signalCount?: number;
}

export const assistantSolidifyProposals = pgTable('assistant_solidify_proposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  batchId: uuid('batch_id').references(() => assistantSolidifyBatches.id, { onDelete: 'cascade' }).notNull(),
  kind: varchar('kind', { length: 20 }).notNull(),
  target: varchar('target', { length: 100 }).notNull(),
  title: varchar('title', { length: 200 }).notNull(),
  body: text('body').notNull(),
  rationale: text('rationale').notNull(),
  sources: jsonb('sources').$type<AssistantSolidifyProposalSource[]>().notNull(),
  status: varchar('status', { length: 16 }).notNull().default('pending'),
  reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
  reviewedAt: timestamp('reviewed_at'),
  appliedAt: timestamp('applied_at'),
  applyError: text('apply_error'),
  /** prompt_correction only: fixes the target module's current max(seq) at inventory time. Detects manual edits at apply time (guards against silent clobber). */
  baseSeq: integer('base_seq'),
  distillModel: varchar('distill_model', { length: 64 }).notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  batchIdx: index('assistant_solidify_proposals_batch_idx').on(t.batchId, t.status),
}));

// ── R3.5 failure lesson distillation: raw failure signals (collection layer, zero LLM) ──
// Structured failure evidence such as the verify nlAiFail triage lands rows here; lesson distillation (at inventory time) consumes only unreferenced signals.
// threadId has no FK: audit-data convention (same as ai_assistant_feedback) — must not cascade away when a version is deleted.
export const assistantFailureSignals = pgTable('assistant_failure_signals', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** v1 only 'nl_ai_fail' (verify natural-language step AI-phase failure triage); later signal types extend this same table. */
  type: varchar('type', { length: 20 }).notNull(),
  threadId: uuid('thread_id').notNull(),
  /** verify's caseId may be a staged draft localId (not a uuid), hence varchar 64. */
  caseId: varchar('case_id', { length: 64 }).notNull(),
  stepOrder: integer('step_order').notNull(),
  /** Source line of the signal (the lesson layer does not isolate by line; approval display/troubleshooting needs the source). */
  productLineId: uuid('product_line_id').references(() => productLines.id, { onDelete: 'set null' }),
  /** {caseTitle, stepInstruction, failureReason, targetUrl, pageUrl} — the snapshot is self-contained, still readable when the thread is untraceable. */
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  // Only one row per (thread, case, step): re-running the same failing step in the same round doesn't duplicate (writer-side onConflictDoNothing)
  stepUq: uniqueIndex('assistant_failure_signals_step_uq').on(t.threadId, t.caseId, t.stepOrder)
    .where(sql`${t.type} = 'nl_ai_fail'`),
  createdIdx: index('assistant_failure_signals_created_idx').on(t.createdAt),
}));

// ── R3.5 failure lesson distillation: lessons (distillation layer, produced by LLM call#1 at inventory time) ──
// Lessons attributed to platform/sut are only stored (R5 platform/SUT improvement material) and must never become prompt patches;
// only prompt/step_description attributions enter asset distillation input.
export const assistantFailureLessons = pgTable('assistant_failure_lessons', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** active | resolved (auto-set after a correction proposal is applied) | retired (manually rejected: false positive/outdated/won't fix). */
  status: varchar('status', { length: 16 }).notNull().default('active'),
  /** prompt | step_description | platform | sut — judged by LLM distillation, misjudgments covered by human approval. */
  attribution: varchar('attribution', { length: 20 }).notNull(),
  /** Human-readable lesson name (granularity like "guide assertion didn't scope the tested path, generalizing into auto-login"). */
  title: varchar('title', { length: 200 }).notNull(),
  /** Structured body: symptom → root cause → impact → suggested fix direction (sections mandated by the distillation prompt). */
  lesson: text('lesson').notNull(),
  /** [{type, refId, excerpt}] — evidence traceability + the ledger basis for idempotent signal consumption. */
  signals: jsonb('signals').notNull(),
  /** Records which correction proposal set it to resolved. */
  resolvedByProposal: uuid('resolved_by_proposal'),
  distillModel: varchar('distill_model', { length: 64 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  statusIdx: index('assistant_failure_lessons_status_idx').on(t.status, t.createdAt),
}));

// ── AI assistant user feedback (Phase 1: collect only, no consumption) ──
// Suggestions/questions/demands users raise about AI replies in conversation, persisted as input for later optimization.
// Deliberately no FK to messages: messages are fully in-memory (SessionManager.inMemory), there is no table to FK to,
// and the pi projection layer's message ids are just positional indexes (pi-msg:<index>), unreproducible after process restart.
// So this table carries its own content snapshot — messageExcerpt is the real basis for retrospection; messageAnchor is only a clue.
// threadId/versionId/projectId are likewise bare uuids without FK: feedback is audit data and must not cascade away
// when a version is deleted (contrast aiStageCases.threadId with no FK — that's staging data, different semantics).
export const aiAssistantFeedback = pgTable('ai_assistant_feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  threadId: uuid('thread_id').notNull(),
  versionId: uuid('version_id').notNull(),
  projectId: uuid('project_id').notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  /** Message role the feedback attaches to. Since 2026-10 the frontend only puts buttons on AI replies, always 'assistant'; column kept for attaching to user messages later. */
  role: varchar('role', { length: 16 }).notNull().default('assistant'),
  /** Frontend projection-layer message id (e.g. 'pi-msg:7'). Positional indexes drift with streaming; a clue only, not a key. */
  messageAnchor: varchar('message_anchor', { length: 64 }),
  messageIndex: integer('message_index'),
  /** Snapshot of the first 500 chars of the message body — after the thread disappears from the UI, admins can still understand the context from this. */
  messageExcerpt: text('message_excerpt'),
  messageAt: timestamp('message_at'),
  sentiment: varchar('sentiment', { length: 16 }).notNull(),
  /** User-added comment, nullable (a 👎 without text still counts as valid feedback). */
  comment: text('comment'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  threadIdx: index('ai_assistant_feedback_thread_idx').on(t.threadId),
  versionIdx: index('ai_assistant_feedback_version_idx').on(t.versionId),
  userIdx: index('ai_assistant_feedback_user_idx').on(t.userId),
}));

// ── AI assistant artifact files (downloadable documents generated by skill scripts) ──
// Skill script produces a file → tool layer registerPersistentArtifact persists to disk + DB → frontend download card.
// Same convention as ai_assistant_feedback: threadId/versionId/projectId are bare uuids without FK — artifacts are
// material already delivered to the user and must not cascade away with version deletion (the file itself on the volume is not cleaned up either).
// Token reuses the UUID form: the download route's TOKEN_RE validation treats both artifact kinds (short TTL / permanent) the same.
export const aiThreadArtifacts = pgTable('ai_thread_artifacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  threadId: uuid('thread_id').notNull(),
  versionId: uuid('version_id').notNull(),
  projectId: uuid('project_id').notNull(),
  /** Download token: the path segment of GET /threads/:id/artifacts/:token. The unique constraint prevents one token from pointing at multiple files. */
  token: text('token').notNull().unique(),
  /** Original file name (with extension, may be Chinese). Browser save name = this column encoded via contentDispositionUtf8. */
  name: text('name').notNull(),
  /** Content-Type: inferred from the extension (MIME_TABLE), or explicitly overridden by the skill manifest. */
  mime: text('mime'),
  size: integer('size').notNull(),
  /** Optional entry count (carries the xmind export semantics: how many cases/case rows the file contains). */
  count: integer('count'),
  /** Absolute path of the file on the volume; replicas share the itest-data volume, so any replica can serve the download. */
  storedPath: text('stored_path').notNull(),
  /** Name of the skill that produced the file (nullable: produced by a native tool rather than a skill script). */
  skillName: text('skill_name'),
  /** null = valid forever. Skill artifacts are permanent (users may download the next day); legacy xmind exports still use in-memory short TTL and don't land in this table. */
  expiresAt: timestamp('expires_at'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  threadIdx: index('ai_thread_artifacts_thread_idx').on(t.threadId),
  versionIdx: index('ai_thread_artifacts_version_idx').on(t.versionId),
}));

// ── Assistant attachments (version-level pre-upload, .docx/.xlsx) ──
// Uploading happens at file selection (a react-pi draft thread has no threadId before its first message, so scope can only be the version).
// The reference tag is spliced into the message body by the frontend adapter in send() (self-closing <uploaded-file …/>);
// the backend never rewrites message text — react-pi reconciles optimistic messages by plaintext key, so any backend rewrite would create duplicate bubbles.
export const aiAssistantAttachments = pgTable('ai_assistant_attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Scope: usable by all threads of the same version; read_thread_attachment uses it for a path+row double constraint. */
  versionId: uuid('version_id').notNull(),
  /** User's original file name (with extension, may be Chinese); used for reference tags and chip display. */
  name: text('name').notNull(),
  /** Corresponding mime for docx/xlsx (the endpoint dispatches by the X-Filename extension whitelist). */
  mime: text('mime').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  /** Dedup key: one file copy and one row per identical content within a version. */
  sha256: text('sha256').notNull(),
  /** Absolute path of the original (<UPLOAD_DIR>/assistant/<versionId>/<sha>.docx|.xlsx). */
  storagePath: text('storage_path').notNull(),
  /** Extracted-text sidecar (<sha>.txt; docx=mammoth, xlsx=exceljs); null when extraction fails (corrupted/encrypted). */
  extractedPath: text('extracted_path'),
  /** Extracted-text char count (the reference tag's chars attribute); null on failure. */
  extractedChars: integer('extracted_chars'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  versionIdx: index('ai_assistant_attachments_version_idx').on(t.versionId),
  // Dedup uniqueness: concurrent uploads of the same file rely on onConflictDoNothing + read-back fallback.
  uniq: uniqueIndex('ai_assistant_attachments_version_sha_unq').on(t.versionId, t.sha256),
}));

// ── Batch solidification (background task solidifying all non-solidified cases NL→DSL) ──
// One trigger = one batch: the batch row only does ownership/audit; per-case rows are updated exclusively by the worker (each BullMQ job touches only its own row,
// batch progress is derived from row statuses at read time, naturally free of concurrent write conflicts). Failure semantics = keep already-persisted DSL + mark the failure reason.
export const solidifyBatches = pgTable('solidify_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  projectIdx: index('solidify_batches_project_idx').on(t.projectId),
}));

export const solidifyBatchCases = pgTable('solidify_batch_cases', {
  id: uuid('id').primaryKey().defaultRandom(),
  batchId: uuid('batch_id').notNull().references(() => solidifyBatches.id, { onDelete: 'cascade' }),
  caseId: uuid('case_id').notNull().references(() => testCases.id, { onDelete: 'cascade' }),
  /** queued → solidifying → solidify_failed | materialize_failed | verifying → passed | verify_failed */
  status: varchar('status', { length: 30 }).notNull().default('queued'),
  /** steps summary returned by the solidify tool (status/reason/compiled), for report display */
  solidifyResult: jsonb('solidify_result'),
  /** Full verify(mode=mechanical) return JSON (failure diagnostic evidence preserved) */
  verifyResult: jsonb('verify_result'),
  error: text('error'),
  startedAt: timestamp('started_at'),
  finishedAt: timestamp('finished_at'),
}, (t) => ({
  batchIdx: index('solidify_batch_cases_batch_idx').on(t.batchId),
  caseIdx: index('solidify_batch_cases_case_idx').on(t.caseId),
}));

// ── Exploratory testing sessions (charter-driven AI fault-finding, producing findings as defect candidates) ──
// Unlike case execution (reports): a session binds to no case/step, and its output is "discoveries" rather than pass/fail.
// A confirmed finding is promoted into a case draft (test_cases); the session itself is a one-shot audit artifact.
export const explorationSessions = pgTable('exploration_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  // projectId redundant column = same as plan_runs: list/auth query directly, avoiding the groups→cases join chain.
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  // cascade (not restrict): a session is an exploration artifact, not a core asset, so it doesn't block version deletion (same criterion as ai_threads).
  versionId: uuid('version_id').notNull().references(() => projectVersions.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 200 }).notNull(),
  charter: text('charter').notNull(),
  persona: varchar('persona', { length: 32 }).notNull().default('qa'),
  startUrl: text('start_url'),
  /** pending → running → completed | failed | cancelled */
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  /** Cancel channel: a pure DB column is naturally correct across replicas, polled by the worker each turn; setting it after a terminal state has no effect (idempotent). */
  cancelRequested: boolean('cancel_requested').notNull().default(false),
  /**
   * Destructive-action authorization bit (default deny): only when the user explicitly checks it at session creation may exploration
   * click irreversible entries like delete/pay/send. The charter is natural language and the model will use it as an excuse
   * (a 2026-11-10 prod log shows an asset actually deleted); the mechanical gate on the aiTask side rejects by visible-text keywords, and authorization comes only from this explicit switch.
   */
  allowDestructive: boolean('allow_destructive').notNull().default(false),
  /**
   * Fault-injection authorization bit (default deny): checked before exploration may inject network loss/slow network/CPU throttling to verify error handling and degradation paths.
   * Same convention as allow_destructive — charter wording doesn't count as authorization; the mechanical gate only honors this explicit switch.
   * Rationale: faults pollute the SUT's session state (its own polling/heartbeat gets interrupted), so a human must sign off.
   */
  allowFaultInjection: boolean('allow_fault_injection').notNull().default(false),
  /**
   * Turn budget (null = code default EXPLORATION_MAX_TURNS): a soft budget; past it shouldAbort winds down gracefully
   * (all discovered findings are kept). The runaway hard gate scales with it (+16), otherwise a user-configured large turn count would be
   * intercepted first by the fixed hard gate, making the configuration pointless. Session wall clock is materialized from turns (60s per turn, clamped to 15~240 minutes) —
   * turns are the only depth knob; a hung single turn is covered separately by the idle watchdog (EXPLORATION_IDLE_TIMEOUT_MS).
   */
  budgetTurns: integer('budget_turns'),
  /**
   * Browser viewport width/height (two states: null = default 1280×800, the headless approximation of a case's "default maximize";
   * effective only when both are given = custom). Semantics align with cases.window_strategy but there is no strategy column —
   * exploration is headless, and the case's "current window" state has no counterpart here.
   */
  windowWidth: integer('window_width'),
  windowHeight: integer('window_height'),
  /**
   * Executor heartbeat: refreshed before each turn of conversation. The watchdog uses it to declare hung sessions dead
   * (release rebuilds the container → process killed → status stays running forever → deletion always 409). 5 minutes without a heartbeat = dead.
   *
   * Uses timestamptz (with timezone): this column is compared "against a cutoff", so it must be an unambiguous absolute moment.
   * Plain timestamp stores "wall clock" — drizzle writes UTC wall clock, native SQL writes local wall clock;
   * mixing them shifts the comparison by a whole timezone offset (measured locally 11-11: the dead-session condition never held).
   */
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
  /**
   * Exclusion ledger (minimal slice of externalized memory): the model's declared "excluded hypotheses + evidence".
   * Stores only exclusions, never beliefs — a blackboard holding beliefs freezes observations into conclusions and self-confirms.
   */
  excludedLedger: jsonb('excluded_ledger').$type<Array<{ claim: string; evidence: string }>>(),
  /**
   * Coverage ledger (pi chain C1): {paths[], interactions[], updatedAt} — visited paths and interaction counts accumulated mechanically,
   * fed back via observe as "already covered, don't repeat"; a snapshot is kept at terminal state for humans to assess coverage.
   */
  coverageLedger: jsonb('coverage_ledger').$type<{
    paths: string[];
    interactions: Array<{ kind: string; count: number }>;
    /** Sub-goal progress (filled after P4 charter decomposition; previously always an empty array). */
    goals: Array<{ id: string; text: string; done: boolean }>;
    updatedAt: string;
  }>(),
  /**
   * Error signals (pi chain D3): console error / pageerror / HTTP 4xx-5xx collection, capped at 200 entries.
   * observe feeds increments back to the model (drain); this keeps the full archive — "the model didn't report it but the page is erroring" can be audited from here.
   */
  errorSignals: jsonb('error_signals').$type<Array<{ at: string; kind: string; text: string; url?: string }>>(),
  /**
   * Persona matrix grouping (C3): sessions sharing a matrix_id = multiple perspectives exploring the same charter in parallel.
   * No new table — three columns (group key + display name + role) suffice (the matrix view aggregates by matrix_id).
   * For a single session (non-matrix), all three columns are null.
   */
  matrixId: uuid('matrix_id'),
  matrixLabel: text('matrix_label'),
  /** This session's role in the matrix = persona key (one of EXPLORATION_PERSONA_KEYS). */
  matrixRole: varchar('matrix_role', { length: 32 }),
  /**
   * Independent review (A3) status: pending (not reviewed) | done (review complete) | failed (review failed) | skipped (no findings).
   * The review annotates rather than adjudicates — findings.status is always decided by human review.
   */
  judgeStatus: varchar('judge_status', { length: 16 }).notNull().default('pending'),
  /** Review summary: {model, channelName, judgedAt, summary, findings:[{id, verdict, reason, confidence}]}. */
  judgeResult: jsonb('judge_result').$type<{
    model?: string;
    channelName?: string;
    judgedAt: string;
    summary?: string;
    error?: string;
    findings: Array<{ id: string; verdict: string; reason: string; confidence: number }>;
  }>(),
  /**
   * Code commit scope (parsed from the charter's natural language): commit window + changed files + candidate entry points.
   * Scope is a focus signal, not a fence — exploration still runs the whole site; scope is only used for targeting (incremental regression/new-feature exploration).
   * Parsing happens in the runner background (LLM + git fetch can take tens of seconds); results become visible to the frontend via polling once persisted.
   */
  codeScope: jsonb('code_scope'),
  /** pending → resolved | none | failed: none=charter has no commit semantics (no git involved); failed=parsing failed (doesn't topple the session). */
  codeScopeStatus: varchar('code_scope_status', { length: 16 }),
  summary: text('summary'),
  error: text('error'),
  turnsUsed: integer('turns_used').notNull().default(0),
  /** Cumulative LLM usage (calls/promptTokens/completionTokens/durationMs/model), accumulated by onUsage. */
  usage: jsonb('usage'),
  /**
   * Session-level action trail (all steps, including the tail after the last finding) — viewed step by step on the detail page's "session process".
   * Relation to findings.actionsTrail: a finding stores the fragment "since the previous finding" (breadcrumb),
   * this stores the complete action sequence of the whole session (audit view: what SQL ran, what was clicked, whether it succeeded).
   */
  actionsTrail: jsonb('actions_trail').$type<
    Array<{ type: string; target: string; ok: boolean; detail?: string; value?: string; ms?: number; key?: string }>
  >(),
  /** Runtime environment snapshot id. Bare uuid without FK: deleting an environment must not cascade into historical exploration records (audit convention). */
  envId: uuid('env_id'),
  startedAt: timestamp('started_at'),
  finishedAt: timestamp('finished_at'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  projectIdx: index('exploration_sessions_project_idx').on(t.projectId, t.createdAt),
  versionIdx: index('exploration_sessions_version_idx').on(t.versionId),
  matrixIdx: index('exploration_sessions_matrix_idx').on(t.matrixId),
}));

export const explorationFindings = pgTable('exploration_findings', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => explorationSessions.id, { onDelete: 'cascade' }),
  order: integer('order').notNull(),
  title: varchar('title', { length: 200 }).notNull(),
  description: text('description').notNull(),
  /** Reuses the P0-P3 vocabulary of test_cases.priority, zero conversion at promote time. */
  severity: varchar('severity', { length: 8 }).notNull().default('P2'),
  /** Repro steps given by the LLM (possibly hallucinated); when reproSteps is empty, promote falls back to textualizing actionsTrail. */
  reproSteps: jsonb('repro_steps').$type<Array<{ action: string; expected?: string }>>().notNull().default([]),
  /** Platform-recorded actual action trail (onAction accumulates since the previous finding) — the ground truth of the action sequence.
   *  value/ms/key are the raw fields needed for the mechanical mapping of the promoted case (fill input value / wait ms / press key name). */
  actionsTrail: jsonb('actions_trail').$type<
    Array<{ type: string; target: string; ok: boolean; detail?: string; value?: string; ms?: number; key?: string }>
  >(),
  /** web path /screenshots/<sessionId>/finding-<order>.png, served by express.static('/screenshots'). */
  screenshotPath: text('screenshot_path'),
  pageUrl: text('page_url'),
  /**
   * Evidence frame metadata (pi chain A1): the finding report tool takes a screenshot first, then persists, at "the moment of decision";
   * this pins the frame's page state — complementary to actionsTrail (the fragment): the trail is how it got here, the frame is what it saw.
   */
  evidenceFrame: jsonb('evidence_frame').$type<{
    url: string;
    viewport: { width: number; height: number } | null;
    capturedAt: string;
    trailIndex: number;
    screenshotPath?: string;
  }>(),
  /**
   * Cross-session intersection (S2): several sessions reported the same defect (same near-duplicate criterion as in-session dedup).
   * ≥2 = jointly discovered from multiple perspectives. **Annotation only** — does not change status (human review is the authority).
   * Always 1 for non-matrix sessions.
   */
  crossSessionCount: integer('cross_session_count').notNull().default(1),
  /**
   * Independent review verdict (A3): {verdict: confirmed|dismissed|unclear, reason, confidence, model, judgedAt}.
   * **Annotation only, does not change status** — the review is a second perspective; human review remains the authority.
   */
  judge: jsonb('judge').$type<{
    verdict: 'confirmed' | 'dismissed' | 'unclear';
    reason: string;
    confidence: number;
    model?: string;
    judgedAt: string;
  }>(),
  /**
   * In-session verification record (report_finding mechanical gate): the model must re-trigger the anomaly and
   * classify it before reporting; failed/missing verification never reaches this column (rejected candidates go to
   * the excluded ledger instead). category taxonomy: code (code defect) / environment (environment configuration
   * problem) / data (test data problem) / ux (usability issue) / other — ALL categories are real defects and all are
   * recommended to the user; the gate only filters unverified candidates, never whole categories.
   */
  verification: jsonb('verification').$type<{
    category: 'code' | 'environment' | 'data' | 'ux' | 'other';
    expected: string;
    actual: string;
    evidence: string[];
    confidence: 'high' | 'medium' | 'low';
    reproducedAt: string;
  }>(),
  /** pending → confirmed | dismissed; confirmed → promoted (writes promotedCaseId). */
  status: varchar('status', { length: 16 }).notNull().default('pending'),
  /** The review trio = same as assistant_solidify_proposals. */
  reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
  reviewedAt: timestamp('reviewed_at'),
  /** Bare uuid: the case may be deleted; the provenance record survives (same convention as resolved_by_proposal). */
  promotedCaseId: uuid('promoted_case_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  sessionIdx: index('exploration_findings_session_idx').on(t.sessionId, t.status),
}));
