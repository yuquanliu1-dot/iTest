import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

let container: StartedPostgreSqlContainer;
let pool: Pool;

const MIGRATIONS_DIR = new URL('../drizzle/', import.meta.url).pathname;

function migrationFile(prefix: string): string {
  const f = readdirSync(MIGRATIONS_DIR).filter((n) => n.startsWith(prefix) && n.endsWith('.sql'));
  if (f.length !== 1) throw new Error(`expected exactly one ${prefix}*.sql, got ${f.join(',')}`);
  return f[0]!;
}

async function applyMigration(prefix: string) {
  const sql = readFileSync(join(MIGRATIONS_DIR, migrationFile(prefix)), 'utf8');
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const s = stmt.trim();
    if (s) await pool.query(s);
  }
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
});

afterAll(async () => {
  await pool.end();
  await container.stop();
});

describe('migrations', () => {
  it('0001-0003 backfill legacy rows into default project/group', async () => {
    await applyMigration('0000');
    // 存量数据：迁移前 schema 里没有 project/group 概念
    await pool.query(`INSERT INTO requirements(title, content) VALUES ('legacy req', 'content')`);
    await pool.query(`INSERT INTO test_cases(title) VALUES ('legacy case')`);

    await applyMigration('0001');
    await applyMigration('0002');
    await applyMigration('0003');

    const projects = await pool.query(`SELECT * FROM projects`);
    expect(projects.rows).toHaveLength(1);
    expect(projects.rows[0]!.name).toBe('默认项目');
    const groups = await pool.query(`SELECT * FROM groups`);
    expect(groups.rows[0]!.name).toBe('默认分组');
    expect(groups.rows[0]!.project_id).toBe(projects.rows[0]!.id);

    const cases = await pool.query(`SELECT * FROM test_cases`);
    expect(cases.rows[0]!.group_id).toBe(groups.rows[0]!.id);
    const reqs = await pool.query(`SELECT * FROM requirements`);
    expect(reqs.rows[0]!.project_id).toBe(projects.rows[0]!.id);
  });
});