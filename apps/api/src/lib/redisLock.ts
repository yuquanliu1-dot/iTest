/**
 * 跨副本分布式锁：SET NX PX + token 比对释放/续期。
 *
 * 3 副本共享同一 Redis（prod228）；token 用进程级 ORIGIN_ID，release/refresh 走
 * Lua 比对后删除/续期，防止锁过期后误删/误续他副本的锁（GET+DEL 两步有竞态）。
 * 无 REDIS_URL（本地 dev / vitest）→ tryAcquireLock 恒成功，单进程语义与现状一致。
 * 所有 Redis 错误吞掉不抛：锁是防重保护，不是正确性依赖，抖动时宁可重复执行。
 */
import { randomUUID } from 'node:crypto';
import IORedis, { type Redis } from 'ioredis';
import { logger } from '../logger.js';

/** 进程级身份：运行锁的 token、事件信封的 origin 都用它。 */
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
  /** 释放（仅当仍持有）。错误吞掉：锁有 TTL 自愈。 */
  release(): Promise<void>;
  /** 续期；返回 false 表示已丢失（过期/被删）。错误按丢失处理。 */
  refresh(): Promise<boolean>;
}

/** 拿不到（他副本持有）返回 null。无 REDIS_URL 返回恒成功锁。 */
export async function tryAcquireLock(key: string, ttlMs: number): Promise<RedisLock | null> {
  const redis = client();
  if (!redis) {
    return { release: async () => {}, refresh: async () => true };
  }
  try {
    const ok = await redis.set(key, ORIGIN_ID, 'PX', ttlMs, 'NX');
    if (ok !== 'OK') return null;
  } catch (err) {
    // 连接失败按「拿不到」处理：调用方走降级（跳过/报错），不建半把锁
    logger.debug({ err: (err as Error).message, key }, 'redisLock acquire failed');
    return null;
  }
  return {
    release: async () => {
      try { await redis.eval(RELEASE_LUA, 1, key, ORIGIN_ID); } catch { /* TTL 自愈 */ }
    },
    refresh: async () => {
      try { return (await redis.eval(REFRESH_LUA, 1, key, ORIGIN_ID, ttlMs)) === 1; }
      catch { return false; }
    },
  };
}
