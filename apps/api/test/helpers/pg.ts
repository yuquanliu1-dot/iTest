import { inject } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

/** Connection info of the shared PG container provided by test/globalSetup.ts. */
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
 * Create a brand-new empty database for this test file in the shared PG container; returns connection info.
 * Equivalent to the old "one container per file" semantics: this file owns the database exclusively; schema changes/TRUNCATE/global assertions do not interfere.
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
