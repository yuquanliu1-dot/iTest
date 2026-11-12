/**
 * Read-only SQL guard: lexical check run before a sql step executes. Same tier as the lexical whitelist —
 * both are string judgments, **not a security boundary** (they can't stop side effects inside stored procedures, nor every variant).
 * The real defense is configuring a read-only account for the SUT database; the error message says so too.
 *
 * Comments and string literals are stripped before judging, avoiding false kills like `SELECT 'delete from t'`.
 */

export const MAX_SQL_CHARS = 8000;

/** Strips line comments, block comments, and single/double-quoted string literals (placeholders kept, length stays readable). */
function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""');
}

/** Explicitly forbidden write/admin keywords (word-boundary matched, so column names like `created_at` don't hit). */
const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COMMIT|ROLLBACK|VACUUM|COPY|REINDEX|CLUSTER|LOCK|CALL|DO|EXECUTE|PREPARE)\b/i;

/** SELECT ... INTO: Postgres table creation, MySQL file writes — both write semantics, blocked separately. */
const SELECT_INTO = /\bINTO\b/i;

export function assertReadOnlySql(raw: string): void {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw sqlGuardError('SQL 不能为空');
  }
  if (raw.length > MAX_SQL_CHARS) {
    throw sqlGuardError(`SQL 长度 ${raw.length} 超过上限 ${MAX_SQL_CHARS}`);
  }
  const stripped = stripLiteralsAndComments(raw);
  const body = stripped.trim();
  if (!/^(SELECT|WITH)\b/i.test(body)) {
    throw sqlGuardError(`只允许 SELECT / WITH 开头的只读语句，当前以 "${body.slice(0, 40)}" 开头`);
  }
  // Semicolons remaining after removing the trailing one = multiple statements
  const noTrail = body.replace(/;\s*$/, '');
  if (noTrail.includes(';')) {
    throw sqlGuardError('只允许单条语句：检测到多个语句分隔符 ";"');
  }
  if (FORBIDDEN.test(noTrail)) {
    const hit = noTrail.match(FORBIDDEN)![0]!.toUpperCase();
    throw sqlGuardError(`只读语句中不允许 ${hit}（如确需写入请走别的工具）`);
  }
  if (SELECT_INTO.test(noTrail)) {
    throw sqlGuardError('只读语句中不允许 INTO（SELECT ... INTO 会建表/写文件）');
  }
}

function sqlGuardError(detail: string): Error {
  const e = new Error(`${detail}。只读守卫是词法检查、非安全边界，请给被测库配只读账号`);
  e.name = 'SqlReadOnlyViolation';
  return e;
}
