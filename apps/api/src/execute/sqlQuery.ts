/**
 * sql 步骤执行器：对被测系统自己的数据库跑单条只读 SQL。
 * 与 dbQuery.ts 的分工：那边只查平台自己的表（平台自检，白名单列），这边查 SUT 的库。
 *
 * 绑定策略：`{{var}}` 一律走【位置参数绑定】（不做字符串拼接，避免注入）；
 * 显式写好的 `$n`（pg）/ `?`（mysql）占位符则由 action.params 顺序填充。
 * 两套绑定不能混用——顺序无法可靠推断，混用直接判死。
 *
 * 三道防线：变量缺失 fail-fast → sqlGuard 词法只读守卫 → 结果序列化截断。
 * 真正的安全边界是被测库的只读账号（守卫挡不住全部变体，见 sqlGuard 注释）。
 */
import { substituteVars, VAR_RE } from '@itest/shared';
import type { SqlStepResult, SqlAction } from '@itest/shared';
import type { QueryPool } from './envContext.js';
import { assertReadOnlySql } from './sqlGuard.js';

/** 单个单元格的最大保留字符数（超出部分截断并标记）。 */
const MAX_CELL_CHARS = 2000;
const TRUNCATE_MARK = '…(截断)';

const TPL_RE = new RegExp(VAR_RE.source, 'g');

export async function runSql(opts: {
  pool: QueryPool;
  action: SqlAction;
  vars?: Record<string, string>;
  /** 执行期解析出的 db 名字（action.dbRef 缺省时用它回填结果）。 */
  dbRef?: string | null;
}): Promise<SqlStepResult> {
  const { pool } = opts;
  const vars = opts.vars ?? {};
  const started = Date.now();
  // compiled DSL 来自 test_steps 落库的原始 JSON，未经 zod 解析 → 缺省值在这里兜住。
  const action = {
    dbRef: opts.action.dbRef,
    sql: opts.action.sql,
    params: opts.action.params ?? [],
    limit: opts.action.limit ?? 50,
    assertion: opts.action.assertion,
  };

  // 1) 变量缺失 fail-fast：缺变量就不该发查询（发出去必然语法错，且会留下误导性错误）。
  const { missing } = substituteVars(action.sql, vars);
  if (missing.length > 0) {
    throw new Error(`var-missing: {{${missing[0]!}}} (sql="${action.sql.slice(0, 100)}")`);
  }

  // 2) 绑定：模板变量与显式占位符二选一。
  const tplCount = [...action.sql.matchAll(TPL_RE)].length;
  const hasExplicitPlaceholder =
    pool.dialect === 'mysql' ? /\?/.test(action.sql) : /\$\d+/.test(action.sql);
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
      return pool.dialect === 'mysql' ? '?' : `$${++n}`;
    });
    params = bound;
  } else {
    sql = action.sql;
    params = action.params.map((p) => (typeof p === 'string' ? substituteVars(p, vars).value : p));
    // params 里的模板变量也做缺失检查（否则把 "{{who}}" 原样当字面量发给库）。
    for (const p of action.params) {
      if (typeof p !== 'string') continue;
      const m = substituteVars(p, vars).missing;
      if (m.length > 0) throw new Error(`var-missing: {{${m[0]!}}} (param="${p.slice(0, 100)}")`);
    }
  }

  // 3) 只读守卫：在触碰数据库前拦下写语句。
  //    守卫跑在【绑定之后】的 SQL 上：变量名可能撞上关键字（如 {{update}}），
  //    而变量值是位置参数、从不进 SQL 文本——守卫看到的永远是最终语句。
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
