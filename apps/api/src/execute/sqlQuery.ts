/**
 * SQL step executor: runs a single read-only SQL statement against the SUT system's own database.
 * 2026-11-08: all DB queries go through this one kind (the old queryDb is retired — it also connected
 * to the environment default db object = the SUT DB, but locked table names to the platform's own
 * tables; the two never matched, so it failed constantly).
 *
 * Binding strategy: `{{var}}` always uses [positional parameter binding] (no string concatenation,
 * to avoid injection); explicitly written `$n` (pg) / `?` (mysql) placeholders are filled in order
 * from action.params. The two binding styles must not be mixed — the order cannot be reliably
 * inferred; mixing is a hard failure.
 *
 * Three lines of defense: missing variable fail-fast → sqlGuard lexical read-only guard → result
 * serialization truncation. The real security boundary is the read-only account on the SUT database
 * (the guard cannot block all variants, see the sqlGuard comments).
 */
import { substituteVars, VAR_RE } from '@itest/shared';
import type { SqlStepResult, SqlAction } from '@itest/shared';
import type { QueryPool } from './envContext.js';
import { assertReadOnlySql } from './sqlGuard.js';

/** Max characters kept per cell (truncated and marked beyond this). */
const MAX_CELL_CHARS = 2000;
const TRUNCATE_MARK = '…(截断)';

const TPL_RE = new RegExp(VAR_RE.source, 'g');

export async function runSql(opts: {
  pool: QueryPool;
  action: SqlAction;
  vars?: Record<string, string>;
  /** DB name resolved at execution time (used to backfill the result when action.dbRef is absent). */
  dbRef?: string | null;
}): Promise<SqlStepResult> {
  const { pool } = opts;
  const vars = opts.vars ?? {};
  const started = Date.now();
  // The compiled DSL is raw JSON persisted in test_steps, not parsed by zod → defaults are clamped here.
  const action = {
    dbRef: opts.action.dbRef,
    sql: opts.action.sql,
    params: opts.action.params ?? [],
    limit: opts.action.limit ?? 50,
    assertion: opts.action.assertion,
  };

  // 1) Missing variable fail-fast: a missing variable means the query must not be sent (it would be a guaranteed syntax error with a misleading message).
  const { missing } = substituteVars(action.sql, vars);
  if (missing.length > 0) {
    throw new Error(`var-missing: {{${missing[0]!}}} (sql="${action.sql.slice(0, 100)}")`);
  }

  // 2) Binding: template variables and explicit placeholders are mutually exclusive.
  const tplCount = [...action.sql.matchAll(TPL_RE)].length;
  const hasExplicitPlaceholder =
    pool.dialect === 'postgres' ? /\$\d+/.test(action.sql) : /\?/.test(action.sql);
  if (tplCount > 0 && (action.params.length > 0 || hasExplicitPlaceholder)) {
    throw new Error(
      `sql-params-conflict: SQL 里的 {{变量}} 与显式占位符/params 不能混用（模板变量会占用前面的占位符位置，顺序无法推断）。` +
        `请只用一种写法。sql="${action.sql.slice(0, 100)}"`,
    );
  }

  let sql: string;
  let params: unknown[];
  if (tplCount > 0) {
    const bound: unknown[] = [];
    let n = 0;
    sql = action.sql.replace(TPL_RE, (_m, name: string) => {
      bound.push(vars[name]);
      return pool.dialect === 'postgres' ? `$${++n}` : '?';
    });
    params = bound;
  } else {
    sql = action.sql;
    params = action.params.map((p) => (typeof p === 'string' ? substituteVars(p, vars).value : p));
    // Template variables inside params also get the missing check (otherwise "{{who}}" is sent to the DB verbatim as a literal).
    for (const p of action.params) {
      if (typeof p !== 'string') continue;
      const m = substituteVars(p, vars).missing;
      if (m.length > 0) throw new Error(`var-missing: {{${m[0]!}}} (param="${p.slice(0, 100)}")`);
    }
  }

  // 3) Read-only guard: intercepts write statements before the database is touched.
  //    The guard runs on the SQL [after binding]: a variable name may collide with a keyword (e.g. {{update}}),
  //    while variable values are positional parameters and never enter the SQL text — the guard always sees the final statement.
  assertReadOnlySql(sql);

  let rows: Record<string, unknown>[];
  try {
    const r = await pool.query(sql, params);
    rows = r.rows;
  } catch (cause) {
    const e = new Error(`只读 SQL 执行失败: ${cause instanceof Error ? cause.message : String(cause)}`);
    e.name = 'SqlError';
    throw e;
  }

  const limit = Math.min(Math.max(1, action.limit), 200);
  const truncated = rows.length > limit;
  const clipped = rows.slice(0, limit).map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = typeof v === 'string' && v.length > MAX_CELL_CHARS
        ? v.slice(0, MAX_CELL_CHARS - TRUNCATE_MARK.length) + TRUNCATE_MARK
        : v;
    }
    return out;
  });

  const result: SqlStepResult = {
    dbRef: action.dbRef ?? opts.dbRef ?? null,
    rowCount: clipped.length,
    durationMs: Date.now() - started,
    rows: clipped,
    // The statement actually sent to the DB + bound parameter values: the report page must be able to compare "what was sent / what came back".
    // Template variable values only go into params (positional binding); sql holds placeholders — that is exactly what is actually sent.
    sql,
    params,
    ...(truncated ? { truncated: true } : {}),
  };

  if (action.assertion) {
    const { match, expected, column } = action.assertion;
    const haystack = column
      ? clipped.map((r) => String(r[column] ?? '')).join('\n')
      : clipped.map((r) => Object.values(r).map((v) => String(v ?? '')).join(' ')).join('\n');
    result.assertion = { matched: matchText(haystack, expected, match), expected, match };
  }
  return result;
}

function matchText(haystack: string, expected: string, match: 'equals' | 'contains' | 'regex'): boolean {
  if (match === 'equals') return haystack.trim() === expected.trim();
  if (match === 'regex') {
    try { return new RegExp(expected).test(haystack); } catch { return false; }
  }
  return haystack.includes(expected);
}
