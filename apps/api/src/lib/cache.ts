/**
 * Redis read-through cache (fail-open).
 *
 * Usage: `await cache.wrap(key, ttlMs, () => loader())` — a hit returns the cache; a miss runs the loader and backfills.
 * Any cache system error is swallowed; behavior degrades to calling the loader directly, leaving business paths untouched.
 *
 * If `REDIS_URL` is missing at startup or the first connection fails → client = null; all calls fall through to the
 * loader. Makes running without redis locally and under vitest easy.
 */

import Redis from 'ioredis';
import { logger } from '../logger.js';

let client: Redis | null = null;
let initialized = false;

/** Lazily initializes once per process. Shuts off when REDIS_URL is unset; if set, tries one ping and shuts off on failure too. */
function getClient(): Redis | null {
  if (initialized) return client;
  initialized = true;
  const url = process.env.REDIS_URL;
  if (!url) {
    logger.debug('cache disabled: REDIS_URL not set');
    return (client = null);
  }
  const r = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  r.on('error', (err) => {
    logger.debug({ err: err.message }, 'cache redis error');
  });
  // One-shot ping: success keeps the client; failure shuts it off, and later wrap calls degrade straight to the loader
  r.connect()
    .then(() => r.ping())
    .then(() => {
      client = r;
      logger.info('cache connected');
    })
    .catch((err: Error) => {
      logger.warn({ err: err.message }, 'cache disabled: initial ping failed');
      r.disconnect();
      client = null;
    });
  return client; // the first call during startup gets null, waiting for the async replacement
}

/**
 * Read-through loader; loader errors propagate as-is, cache system errors are swallowed.
 * T must be JSON-serializable (Date/Map/Set etc. cannot pass directly; the caller preprocesses).
 */
export async function wrap<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const c = getClient();
  if (!c) return loader();
  try {
    const hit = await c.get(key);
    if (hit !== null) {
      logger.debug({ key }, 'cache hit');
      return JSON.parse(hit) as T;
    }
  } catch (err) {
    logger.debug({ key, err: (err as Error).message }, 'cache get failed');
  }
  const value = await loader();
  // null/undefined are not cached (avoids "not found" hits being misjudged for a long time)
  if (value !== null && value !== undefined) {
    try {
      await c.set(key, JSON.stringify(value), 'PX', ttlMs);
    } catch (err) {
      logger.debug({ key, err: (err as Error).message }, 'cache set failed');
    }
  }
  return value;
}

/** Explicitly invalidates a single key; swallows failures. */
export async function del(key: string): Promise<void> {
  const c = getClient();
  if (!c) return;
  try {
    await c.del(key);
  } catch (err) {
    logger.debug({ key, err: (err as Error).message }, 'cache del failed');
  }
}

/**
 * Wildcard invalidation (uses SCAN to avoid the KEYS command blocking).
 * Example patterns: `tags:*`, `memberships:*`.
 */
export async function delPattern(pattern: string): Promise<void> {
  const c = getClient();
  if (!c) return;
  try {
    let cursor = '0';
    do {
      const [cur, keys] = await c.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = cur;
      if (keys.length > 0) await c.del(...keys);
    } while (cursor !== '0');
  } catch (err) {
    logger.debug({ pattern, err: (err as Error).message }, 'cache delPattern failed');
  }
}

/** Namespace object; callers uniformly use `cache.del` / `cache.delPattern` / `cache.wrap`. */
export const cache = { del, delPattern, wrap };

/** Test-only: resets the singleton, allowing mock replacement. */
export function __resetClientForTests(): void {
  if (client) client.disconnect();
  client = null;
  initialized = false;
}

/** Test-only: force-injects the client (skipping the ping liveness check). */
export function __setClientForTests(c: Redis | null): void {
  if (client) client.disconnect();
  client = c;
  initialized = true;
}