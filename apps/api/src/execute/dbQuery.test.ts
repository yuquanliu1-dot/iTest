import { describe, it, expect } from 'vitest';
import { QueryDbError, QueryDbColumnNotAllowed, QueryDbTableNotAllowed, assertColumnsAllowed, ALLOWED_QUERY_COLUMNS, buildSelectSql, runQueryDb } from './dbQuery.js';
import type { QueryPool } from './envContext.js';

/** 假池：记录被执行的 sql / params。 */
function fakePool(rows: Record<string, unknown>[], dialect: 'postgres' | 'mysql' = 'postgres'): QueryPool & { calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    dialect,
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows };
    },
    async end() {},
  };
}

describe('assertColumnsAllowed', () => {
  it('accepts known columns', () => {
    expect(() => assertColumnsAllowed('reports', ['id', 'status'])).not.toThrow();
  });
  it('rejects unknown column', () => {
    expect(() => assertColumnsAllowed('reports', ['secret_password'])).toThrow(QueryDbColumnNotAllowed);
  });
  it('rejects unknown table', () => {
    expect(() => assertColumnsAllowed('payments', ['id'])).toThrow(QueryDbTableNotAllowed);
  });
});

describe('ALLOWED_QUERY_COLUMNS', () => {
  it('never includes password / secret columns', () => {
    for (const cols of Object.values(ALLOWED_QUERY_COLUMNS)) {
      for (const c of cols) {
        expect(c).not.toMatch(/password|secret|token/i);
      }
    }
  });
  it('covers newer plan / dataset tables', () => {
    expect(() => assertColumnsAllowed('datasets', ['id', 'project_id', 'name'])).not.toThrow();
    expect(() => assertColumnsAllowed('plan_case_groups', ['id', 'plan_id', 'fail_fast', 'login_dataset_row_indexes'])).not.toThrow();
    expect(() => assertColumnsAllowed('plan_cases', ['id', 'plan_id', 'case_id', 'group_id', 'dataset_row_indexes'])).not.toThrow();
    expect(() => assertColumnsAllowed('plan_schedules', ['id', 'plan_id', 'cron_expr', 'enabled'])).not.toThrow();
  });
});

describe('runQueryDb (integration placeholder)', () => {
  it('placeholder', () => { expect(QueryDbError).toBeDefined(); });
});

describe('buildSelectSql', () => {
  it('postgres: double-quoted identifiers + $n placeholders', () => {
    const { sql, params } = buildSelectSql('postgres', 'reports', ['id', 'status'], [{ column: 'status', equals: 'failed' }], 10);
    expect(sql).toBe('SELECT "id", "status" FROM "reports" WHERE "status" = $1 LIMIT 10');
    expect(params).toEqual(['failed']);
  });

  it('postgres: escapes embedded double quotes in identifiers', () => {
    const { sql } = buildSelectSql('postgres', 'reports', ['we"ird'], [], 5);
    expect(sql).toContain('"we""ird"');
  });

  it('mysql: backtick identifiers + ? placeholders', () => {
    const { sql, params } = buildSelectSql('mysql', 'reports', ['id'], [{ column: 'status', equals: 'failed' }, { column: 'case_id', equals: 'c1' }], 10);
    expect(sql).toBe('SELECT `id` FROM `reports` WHERE `status` = ? AND `case_id` = ? LIMIT 10');
    expect(params).toEqual(['failed', 'c1']);
  });

  it('mysql: escapes embedded backticks in identifiers', () => {
    const { sql } = buildSelectSql('mysql', 'reports', ['we`ird'], [], 5);
    expect(sql).toContain('`we``ird`');
  });

  it('empty where → no WHERE clause, empty params', () => {
    const { sql, params } = buildSelectSql('postgres', 'reports', ['id'], [], 7);
    expect(sql).toBe('SELECT "id" FROM "reports" LIMIT 7');
    expect(params).toEqual([]);
  });
});

describe('runQueryDb', () => {
  it('结果带上实际执行的 SQL 与绑定参数（报告页对照「发了什么/回了什么」）', async () => {
    const pool = fakePool([{ id: 'r1', status: 'failed' }]);
    const r = await runQueryDb({
      pool,
      action: { kind: 'queryDb', table: 'reports', where: [{ column: 'status', equals: 'failed' }], columns: ['id'], limit: 10 },
    });
    expect(r.sql).toBe('SELECT "id" FROM "reports" WHERE "status" = $1 LIMIT 10');
    expect(r.params).toEqual(['failed']);
    expect(r.rows).toEqual([{ id: 'r1', status: 'failed' }]);
  });

  it('mysql 方言的 SQL 同样落结果（? 占位符）', async () => {
    const pool = fakePool([], 'mysql');
    const r = await runQueryDb({
      pool,
      action: { kind: 'queryDb', table: 'reports', where: [{ column: 'status', equals: 'failed' }], columns: ['id'], limit: 10 },
    });
    expect(r.sql).toBe('SELECT `id` FROM `reports` WHERE `status` = ? LIMIT 10');
    expect(r.params).toEqual(['failed']);
  });
});
