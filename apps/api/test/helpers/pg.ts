import { inject } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

/** test/globalSetup.ts provide 的共享 PG 容器连接信息。 */
interface PgInfo {
  host: string;
  port: number;
  user: string;
  password: string;
}

export interface TestDatabase {
  uri: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

const pgInfo = inject('pgInfo') as PgInfo | undefined;
if (!pgInfo) {
  throw new Error('pgInfo 未提供：vitest.config.ts 缺少 globalSetup，或 helpers/pg.ts 被非测试上下文 import');
}

/**
 * 在共享 PG 容器里为本测试文件建一个全新的空数据库，返回连接信息。
 * 与旧的"每文件一个容器"语义等价：本文件独占该库，schema 变更/TRUNCATE/全局断言互不影响。
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const database = `itest_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const client = new Client({
    host: pgInfo.host,
    port: pgInfo.port,
    user: pgInfo.user,
    password: pgInfo.password,
    database: 'postgres',
  });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${database}"`);
  } finally {
    await client.end();
  }
  const url = new URL('', 'postgres://');
  url.hostname = pgInfo.host;
  url.port = String(pgInfo.port);
  url.pathname = database;
  url.username = pgInfo.user;
  url.password = pgInfo.password;
  return { uri: url.toString(), host: pgInfo.host, port: pgInfo.port, user: pgInfo.user, password: pgInfo.password, database };
}
