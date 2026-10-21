/**
 * 只读 SQL 守卫：sql 步骤执行前的词法检查。与 ALLOWED_QUERY_COLUMNS 同级——
 * 都是字符串判定，**不是安全边界**（挡不住存储过程中的副作用与全部变体）。
 * 真正的防线是给被测库配只读账号；错误提示里也这么讲。
 *
 * 剥掉注释与字符串字面量后再判定，避免 `SELECT 'delete from t'` 这类误杀。
 */

export const MAX_SQL_CHARS = 8000;

/** 去掉行注释、块注释与单引号/双引号字符串字面量（保留占位，保持长度可读）。 */
function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""');
}

/** 明确禁止的写/管理关键字（词边界匹配，避免命中列名如 `created_at`）。 */
const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COMMIT|ROLLBACK|VACUUM|COPY|REINDEX|CLUSTER|LOCK|CALL|DO|EXECUTE|PREPARE)\b/i;

/** SELECT ... INTO：Postgres 建表、MySQL 写文件——都是写语义，单独拦。 */
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
  // 去尾分号后仍含分号 = 多语句
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
