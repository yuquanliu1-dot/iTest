import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  jsonb,
  timestamp,
  boolean,
} from 'drizzle-orm/pg-core';

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
  url: text('url'),
  title: varchar('title', { length: 200 }).notNull(),
  description: text('description'),
  priority: varchar('priority', { length: 20 }).notNull().default('P1'),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const testSteps = pgTable('test_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id').references(() => testCases.id, { onDelete: 'cascade' }).notNull(),
  order: integer('order').notNull(),
  name: varchar('name', { length: 200 }),
  delayMs: integer('delay_ms'),
  source: varchar('source', { length: 20 }).notNull(),
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
  summary: text('summary'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 200 }).notNull(),
  defaultUrl: text('default_url'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const groups = pgTable('groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 200 }).notNull(),
  defaultUrl: text('default_url'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const executionPlans = pgTable('execution_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 200 }).notNull(),
  environment: varchar('environment', { length: 100 }),
  strategy: varchar('strategy', { length: 20 }).notNull().default('run_all'),
  loginPrepareEnabled: boolean('login_prepare_enabled').notNull().default(false),
  loginCaseId: uuid('login_case_id').references(() => testCases.id, { onDelete: 'set null' }),
  detectionUrl: text('detection_url'),
  loginSuccessSelector: text('login_success_selector'),
  loginUnauthorizedKeywords: jsonb('login_unauthorized_keywords'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

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
