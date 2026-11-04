import { describe, it, expect } from 'vitest';
import { Client } from 'pg';
import { createTestDatabase } from './helpers/pg.js';

describe('pg fixture（共享容器 + 每文件独立数据库）', () => {
  it('createTestDatabase 返回的 URI 各段拼接正确且可连接', async () => {
    const db = await createTestDatabase();
    expect(db.uri).toBe(`postgres://${db.user}:${db.password}@${db.host}:${db.port}/${db.database}`);
    expect(db.database).toMatch(/^itest_[0-9a-f]{16}$/);
    const client = new Client({ connectionString: db.uri });
    await client.connect();
    try {
      const r = await client.query('SELECT current_database() AS db');
      expect(r.rows[0]!.db).toBe(db.database);
    } finally {
      await client.end();
    }
  });

  it('两个测试库互相隔离：写入互不可见', async () => {
    const a = await createTestDatabase();
    const b = await createTestDatabase();
    expect(a.database).not.toBe(b.database);

    const ca = new Client({ connectionString: a.uri });
    const cb = new Client({ connectionString: b.uri });
    await ca.connect();
    await cb.connect();
    try {
      await ca.query('CREATE TABLE marker (v text)');
      await ca.query(`INSERT INTO marker VALUES ('only-in-a')`);
      const rb = await cb.query(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'marker'`,
      );
      expect(rb.rows[0]!.n).toBe(0);
      const ra = await ca.query('SELECT v FROM marker');
      expect(ra.rows[0]!.v).toBe('only-in-a');
    } finally {
      await ca.end();
      await cb.end();
    }
  });

  it('新库是空的：不含 SCHEMA_SQL 的任何表', async () => {
    const db = await createTestDatabase();
    const client = new Client({ connectionString: db.uri });
    await client.connect();
    try {
      const r = await client.query(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`,
      );
      expect(r.rows[0]!.n).toBe(0);
    } finally {
      await client.end();
    }
  });
});
