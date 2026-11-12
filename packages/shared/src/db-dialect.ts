/**
 * Dialect determination for environment db objects.
 *
 * Background: in a db object's payload `dbType` is the authoritative field, but legacy data may lack it —
 * observed on prod228, 2026-10-28: when upserting, the AI tool wrote only `url` (jdbc:mysql://…) and omitted
 * `dbType`, so the old "default postgres" logic connected to MySQL as if it were PG, and the resulting
 * `Connection terminated unexpectedly` completely masked the real cause (the PG driver cannot read a MySQL handshake packet).
 *
 * Decision order:
 *   1. `dbType` explicitly given → use it directly (the sole authority).
 *   2. Absent → infer from the jdbc prefix of `url` (`jdbc:mysql://` → mysql,
 *      `jdbc:postgresql://` → postgres). This is a strong signal — "if the AI wrote a jdbc url, the
 *      dialect is necessarily that one" — jdbc urls are copied from the SUT's config by users, more reliable than the port.
 *   3. Neither → postgres (compatible with the flattened old data from migration 0023: those databases really are all PG).
 */

/** Dialects: postgres / mysql / gauss100 (GaussDB 100, Zenith proprietary protocol; no Node driver, goes through the HTTP bridge). Naming matches apps/api's DbDialect. */
export type DbDialect = 'postgres' | 'mysql' | 'gauss100';

/** Dialect-relevant fields in a db object's payload (the rest are irrelevant). */
export interface DbDialectPayload {
  dbType?: unknown;
  url?: unknown;
}

/**
 * jdbc url → dialect. Only the url scheme prefix is recognized, no host/port parsing:
 * `jdbc:mysql://…` / `jdbc:postgresql://…` / `jdbc:zenith:@…` (GaussDB 100, note: no `//`).
 * Returns null when unrecognized (the caller falls back to the default).
 */
export function dialectFromJdbcUrl(url: unknown): DbDialect | null {
  if (typeof url !== 'string') return null;
  const s = url.trim().toLowerCase();
  if (s.startsWith('jdbc:mysql://')) return 'mysql';
  if (s.startsWith('jdbc:postgresql://')) return 'postgres';
  if (s.startsWith('jdbc:zenith:@')) return 'gauss100';
  return null;
}

/**
 * Dialect determination for a db object (shared by probing and runtime, see apps/api/src/execute/envContext.ts).
 *
 * @param payload the db object's raw payload (unmasked)
 * @param fallback dialect used when nothing can be determined, defaults to postgres (the migration-0023 legacy data is all PG)
 */
export function resolveDbDialect(payload: DbDialectPayload | null | undefined, fallback: DbDialect = 'postgres'): DbDialect {
  if (!payload) return fallback;
  if (payload.dbType === 'mysql' || payload.dbType === 'postgres' || payload.dbType === 'gauss100') return payload.dbType;
  const fromUrl = dialectFromJdbcUrl(payload.url);
  if (fromUrl) return fromUrl;
  return fallback;
}

/** Default port per dialect (gauss100's "database name" = schema, port 2888). */
export function defaultDbPort(dialect: DbDialect): number {
  switch (dialect) {
    case 'mysql':
      return 3306;
    case 'gauss100':
      return 2888;
    default:
      return 5432;
  }
}
