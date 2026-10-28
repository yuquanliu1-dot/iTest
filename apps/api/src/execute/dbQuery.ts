import type { QueryDbAction, DbAssertionMatch, DbQueryRowResult } from '@itest/shared';
import type { QueryPool, DbDialect } from './envContext.js';

export class QueryDbError extends Error {
  constructor(msg: string) { super(msg); this.name = 'QueryDbError'; }
}
export class QueryDbTableNotAllowed extends Error {
  constructor(t: string) { super(`table not allowed: ${t}`); this.name = 'QueryDbTableNotAllowed'; }
}
export class QueryDbColumnNotAllowed extends Error {
  constructor(c: string) { super(`column not allowed: ${c}`); this.name = 'QueryDbColumnNotAllowed'; }
}

export const ALLOWED_QUERY_COLUMNS: Record<string, ReadonlySet<string>> = {
  projects: new Set(['id', 'product_line_id', 'name', 'description', 'repo_url', 'default_branch', 'provider', 'gitlab_url_override', 'created_at', 'updated_at']),
  groups: new Set(['id', 'project_id', 'name', 'created_at', 'updated_at']),
  users: new Set(['id', 'username', 'display_name', 'email', 'language_preference', 'created_at', 'updated_at']),
  test_cases: new Set(['id', 'requirement_id', 'group_id', 'title', 'priority', 'status', 'scenario_id', 'default_env_id', 'created_at', 'updated_at']),
  test_steps: new Set(['id', 'case_id', 'order', 'name', 'source', 'tab_ref', 'component_kind', 'created_at']),
  reports: new Set(['id', 'case_id', 'status', 'duration_ms', 'created_at']),
  test_environments: new Set(['id', 'project_id', 'name', 'is_default', 'created_at', 'updated_at']),
  environment_objects: new Set(['id', 'environment_id', 'object_type', 'label', 'is_default', 'created_at', 'updated_at']),
  execution_plans: new Set(['id', 'project_id', 'name', 'environment', 'environment_id', 'strategy', 'login_prepare_enabled', 'created_at', 'updated_at']),
  plan_runs: new Set(['id', 'plan_id', 'project_id', 'status', 'started_at', 'finished_at', 'duration_ms', 'total_cases', 'passed_cases', 'failed_cases', 'skipped_cases']),
  plan_run_cases: new Set(['id', 'plan_run_id', 'case_id', 'report_id', 'order', 'status', 'step_kind', 'started_at', 'finished_at', 'duration_ms']),
  test_attachments: new Set(['id', 'case_id', 'project_id', 'step_id', 'original_name', 'size', 'sha256', 'created_at']),
};

export function assertColumnsAllowed(table: string, columns: string[]): void {
  const allowed = ALLOWED_QUERY_COLUMNS[table];
  if (!allowed) throw new QueryDbTableNotAllowed(table);
  for (const c of columns) {
    if (!allowed.has(c)) throw new QueryDbColumnNotAllowed(c);
  }
}

export type { DbQueryRowResult };

const TRUNCATE = 50;

/** 双方言 SELECT 构造：标识符 pg `"col"`（`""` 转义）/ mysql `` `col` ``（`` `` `` 转义）；占位符 pg `$n` / mysql `?`。 */
export function buildSelectSql(
  dialect: DbDialect,
  table: string,
  columns: string[],
  where: ReadonlyArray<{ column: string; equals: unknown }>,
  limit: number,
): { sql: string; params: unknown[] } {
  const quote = (id: string) =>
    dialect === 'mysql' ? `\`${id.replace(/`/g, '``')}\`` : `"${id.replace(/"/g, '""')}"`;
  const placeholder = (i: number) => (dialect === 'mysql' ? '?' : `$${i + 1}`);

  const params: unknown[] = [];
  const whereParts = where.map((w, i) => {
    params.push(w.equals);
    return `${quote(w.column)} = ${placeholder(i)}`;
  });

  const sql = [
    'SELECT',
    columns.map(quote).join(', '),
    `FROM ${quote(table)}`,
    whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '',
    `LIMIT ${limit}`,
  ].filter(Boolean).join(' ');
  return { sql, params };
}

export async function runQueryDb(opts: {
  pool: QueryPool;
  action: QueryDbAction;
}): Promise<DbQueryRowResult> {
  const { pool, action } = opts;
  const table = action.table;
  const requestedCols = action.columns.length ? action.columns : Array.from(ALLOWED_QUERY_COLUMNS[table]!);
  assertColumnsAllowed(table, requestedCols);

  const where = action.where;
  for (const { column } of where) {
    if (!ALLOWED_QUERY_COLUMNS[table]!.has(column)) throw new QueryDbColumnNotAllowed(column);
  }

  const limit = Math.min(action.limit, 200);
  const { sql, params } = buildSelectSql(pool.dialect, table, requestedCols, where, limit);

  const t0 = Date.now();
  let rows: Record<string, unknown>[];
  try {
    const result = await pool.query(sql, params);
    rows = result.rows;
  } catch (e) {
    throw new QueryDbError(e instanceof Error ? e.message : String(e));
  }

  const durationMs = Date.now() - t0;
  const truncated = rows.length > TRUNCATE;
  const truncatedRows = truncated ? rows.slice(0, TRUNCATE) : rows;

  let assertion: DbQueryRowResult['assertion'];
  if (action.assertion) {
    assertion = {
      matched: matchesAssertion(truncatedRows, action.assertion.match, action.assertion.expected, action.assertion.column),
      expected: action.assertion.expected,
      match: action.assertion.match,
    };
  }

  // sql/params = 实际发给库的语句与绑定值（报告页对照「发了什么 / 回了什么」）
  return { rowCount: rows.length, durationMs, rows: truncatedRows, sql, params, ...(truncated ? { truncated: true } : {}), assertion };
}

function matchesAssertion(
  rows: Record<string, unknown>[],
  match: DbAssertionMatch,
  expected: string,
  column?: string,
): boolean {
  for (const row of rows) {
    if (column) {
      if (compareValue(row[column], match, expected)) return true;
      continue;
    }
    for (const v of Object.values(row)) {
      if (compareValue(v, match, expected)) return true;
    }
  }
  return false;
}

function compareValue(v: unknown, match: DbAssertionMatch, expected: string): boolean {
  const s = v === null || v === undefined ? '' : String(v);
  if (match === 'equals') return s === expected;
  if (match === 'contains') return s.includes(expected);
  if (match === 'regex') {
    try { return new RegExp(expected).test(s); } catch { return false; }
  }
  return false;
}