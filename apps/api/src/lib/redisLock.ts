/**
 * Cross-replica distributed lock: SET NX PX + token-compared release/refresh.
 *
 * 3 replicas share one Redis (prod228); the token is the process-level ORIGIN_ID, and release/refresh
 * run Lua compare-then-delete/pexpire, preventing a replica from wrongly deleting/renewing another replica's
 * lock after expiry (the GET+DEL two-step has a race).
 * Without REDIS_URL (local dev / vitest) → tryAcquireLock always succeeds, matching the current single-process semantics.
 * All Redis errors are swallowed, not thrown: the lock is duplicate-run protection, not a correctness dependency;
 * under flakiness, re-execution is preferable.
 */
import { randomUUID } from 'node:crypto';
import IORedis, { type Redis } from 'ioredis';
import { logger } from '../logger.js';

/** Process-level identity: used by the run-lock token and the origin of event envelopes. */
export const ORIGIN_ID = randomUUID();

let _client: Redis | null = null;
function client(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  if (!_client) {
    _client = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
    _client.on('error', (err) => logger.debug({ err: err.message }, 'redisLock client error'));
  }
  return _client;
}

const RELEASE_LUA = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end';
const REFRESH_LUA = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) end';

export interface RedisLock {
  /** Releases (only while still held). Errors swallowed: the lock has a TTL to self-heal. */
  release(): Promise<void>;
  /** Renews; returning false means the lock was lost (expired/deleted). Errors are treated as lost. */
  refresh(): Promise<boolean>;
}

/** Returns null when the lock cannot be acquired (held by another replica). Without REDIS_URL returns an always-successful lock. */
export async function tryAcquireLock(key: string, ttlMs: number): Promise<RedisLock | null> {
  const redis = client();
  if (!redis) {
    return { release: async () => {}, refresh: async () => true };
  }
  try {
    const ok = await redis.set(key, ORIGIN_ID, 'PX', ttlMs, 'NX');
    if (ok !== 'OK') return null;
  } catch (err) {
    // Connection failure is treated as "not acquired": the caller degrades (skip/error) rather than building half a lock
    logger.debug({ err: (err as Error).message, key }, 'redisLock acquire failed');
    return null;
  }
  return {
    release: async () => {
      try { await redis.eval(RELEASE_LUA, 1, key, ORIGIN_ID); } catch { /* TTL self-heals */ }
    },
    refresh: async () => {
      try { return (await redis.eval(REFRESH_LUA, 1, key, ORIGIN_ID, ttlMs)) === 1; }
      catch { return false; }
    },
  };
}
