/**
 * Redis read-through cache (fail-open).
 *
 * 用法:`await cache.wrap(key, ttlMs, () => loader())` — 命中返回缓存,未命中走 loader 并回填。
 * 任一缓存系统错误被吞掉,行为退化为直接调用 loader,不影响业务路径。
 *
 * 启动时 `REDIS_URL` 缺失或首次连接失败 → client = null,所有调用失败到 loader;便于本地无 redis 与 vitest。
 */

import Redis from 'ioredis';
import { logger } from '../logger.js';

let client: Redis | null = null;
let initialized = false;

/** 进程内惰性初始化一次。REDIS_URL 未设置时直接关掉;设置则尝试 ping 一次,失败也关掉。 */
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
  // 一次性 ping:成功保留 client;失败关掉,后续 wrap 直接退化到 loader
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
  return client; // 启动期间第一次调用拿到的是 null,等异步替换
}

/**
 * 读穿透 loader;loader 抛错原样向上,缓存系统错误被吞。
 * T 必须可 JSON 序列化(Date/Map/Set 等不可直接走;调用方负责预处理)。
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
  // null/undefined 不入缓存(避免命中"未找到"被长期误判)
  if (value !== null && value !== undefined) {
    try {
      await c.set(key, JSON.stringify(value), 'PX', ttlMs);
    } catch (err) {
      logger.debug({ key, err: (err as Error).message }, 'cache set failed');
    }
  }
  return value;
}

/** 显式失效单 key;吞失败。 */
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
 * 通配失效(用 SCAN,避免 KEYS 命令阻塞)。
 * pattern 例:`tags:*`、`memberships:*`。
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

/** 命名空间对象,引用统一调用 `cache.del` / `cache.delPattern` / `cache.wrap`。 */
export const cache = { del, delPattern, wrap };

/** 仅供测试用:重置单例,允许 mock 替换。 */
export function __resetClientForTests(): void {
  if (client) client.disconnect();
  client = null;
  initialized = false;
}

/** 仅供测试用:强制注入 client(跳过 ping 探活)。 */
export function __setClientForTests(c: Redis | null): void {
  if (client) client.disconnect();
  client = c;
  initialized = true;
}