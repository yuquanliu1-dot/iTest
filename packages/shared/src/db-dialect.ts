/**
 * 环境 db 对象的库型（方言）判定。
 *
 * 背景：db 对象的 payload 里 `dbType` 是权威字段，但存量数据可能没有它——
 * 2026-10-28 prod228 实测，AI 工具 upsert 时只写了 `url`(jdbc:mysql://…) 而漏了
 * `dbType`，于是「缺省 postgres」的旧逻辑把 MySQL 当 PG 连，报出的
 * `Connection terminated unexpectedly` 完全掩盖了真实原因（PG 驱动读不懂 MySQL 握手包）。
 *
 * 判定顺序：
 *   1. `dbType` 显式给了 → 直接用（唯一权威）。
 *   2. 没给 → 从 `url` 的 jdbc 前缀推断（`jdbc:mysql://` → mysql，
 *      `jdbc:postgresql://` → postgres）。这是「AI 写了 jdbc url 就必然是那个库型」的
 *      强信号——jdbc url 是用户从被测系统配置里抄来的，比端口号可靠。
 *   3. 都没有 → postgres（兼容 0023 迁移平铺的老数据：那些库确实都是 PG）。
 */

/** 库型：postgres / mysql。命名与 apps/api 的 DbDialect 一致。 */
export type DbDialect = 'postgres' | 'mysql';

/** db 对象 payload 里与库型判定相关的字段（其余字段不关心）。 */
export interface DbDialectPayload {
  dbType?: unknown;
  url?: unknown;
}

/**
 * jdbc url → 方言。只认 url 的 scheme 前缀，不解析 host/port：
 * `jdbc:mysql://…` / `jdbc:postgresql://…`（含 `jdbc:postgresqls://`? 不认）。
 * 认不出就返回 null（交由调用方回落到缺省）。
 */
export function dialectFromJdbcUrl(url: unknown): DbDialect | null {
  if (typeof url !== 'string') return null;
  const s = url.trim().toLowerCase();
  if (s.startsWith('jdbc:mysql://')) return 'mysql';
  if (s.startsWith('jdbc:postgresql://')) return 'postgres';
  return null;
}

/**
 * db 对象的库型判定（探测与运行期共用，见 apps/api/src/execute/envContext.ts）。
 *
 * @param payload db 对象的原始 payload（未脱敏）
 * @param fallback 无从判定时的缺省库型，默认 postgres（0023 迁移的老数据都是 PG）
 */
export function resolveDbDialect(payload: DbDialectPayload | null | undefined, fallback: DbDialect = 'postgres'): DbDialect {
  if (!payload) return fallback;
  if (payload.dbType === 'mysql' || payload.dbType === 'postgres') return payload.dbType;
  const fromUrl = dialectFromJdbcUrl(payload.url);
  if (fromUrl) return fromUrl;
  return fallback;
}
