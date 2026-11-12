import { describe, it, expect } from 'vitest';
import type { QueryPool } from '../src/execute/envContext.js';
import { runSql } from '../src/execute/sqlQuery.js';
import { STEP_DSL_SPEC } from '../src/agent/prompts/step-dsl-spec.js';

/** Fake pool: records the executed sql / params, throws on demand. */
function fakePool(
  rows: Record<string, unknown>[],
  opts: { fail?: Error; dialect?: 'postgres' | 'mysql' | 'gauss100' } = {},
): QueryPool & { calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    dialect: opts.dialect ?? 'postgres',
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (opts.fail) throw opts.fail;
      return { rows };
    },
    async end() {},
  };
}

const base = { kind: 'sql' as const, params: [], limit: 10 };

describe('runSql', () => {
  it('变量绑定为位置参数，按 limit 截断，记录 dbRef 与耗时', async () => {
    const pool = fakePool(Array.from({ length: 5 }, (_, i) => ({ id: i })));
    const r = await runSql({
      pool,
      action: { ...base, dbRef: 'olap', sql: 'SELECT * FROM dw WHERE u = {{name}}', limit: 3 },
      vars: { name: 'alice' },
    });
    expect(pool.calls[0]!.sql).toBe('SELECT * FROM dw WHERE u = $1');
    expect(pool.calls[0]!.params).toEqual(['alice']);
    expect(r.rowCount).toBe(3);
    expect(r.dbRef).toBe('olap');
    expect(r.truncated).toBe(true);
    expect(r.rows).toHaveLength(3);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('mysql 用 ? 占位，postgres 用 $n', async () => {
    const pg = fakePool([], { dialect: 'postgres' });
    await runSql({ pool: pg, action: { ...base, sql: 'SELECT {{a}}, {{b}}' }, vars: { a: 'x', b: 'y' } });
    expect(pg.calls[0]!.sql).toBe('SELECT $1, $2');
    expect(pg.calls[0]!.params).toEqual(['x', 'y']);

    const my = fakePool([], { dialect: 'mysql' });
    await runSql({ pool: my, action: { ...base, sql: 'SELECT {{a}}, {{b}}' }, vars: { a: 'x', b: 'y' } });
    expect(my.calls[0]!.sql).toBe('SELECT ?, ?');
    expect(my.calls[0]!.params).toEqual(['x', 'y']);
  });

  it('gauss100 与 mysql 同用 ? 占位（显式占位符检测亦按 ? 判定）', async () => {
    const g = fakePool([], { dialect: 'gauss100' });
    await runSql({ pool: g, action: { ...base, sql: 'SELECT {{a}}, {{b}}' }, vars: { a: 'x', b: 'y' } });
    expect(g.calls[0]!.sql).toBe('SELECT ?, ?');
    expect(g.calls[0]!.params).toEqual(['x', 'y']);

    // Explicit ? mixed with template variables → conflict rejection (same semantics as mysql)
    const g2 = fakePool([], { dialect: 'gauss100' });
    await expect(
      runSql({ pool: g2, action: { ...base, sql: 'SELECT ? , {{v}}', params: ['p'] }, vars: { v: 'k' } }),
    ).rejects.toThrow(/sql-params-conflict/);
    expect(g2.calls).toHaveLength(0);
  });

  it('同一变量出现多次 → 按出现次数重复绑定', async () => {
    const pool = fakePool([]);
    await runSql({ pool, action: { ...base, sql: 'SELECT {{v}}, {{v}}' }, vars: { v: 'k' } });
    expect(pool.calls[0]!.sql).toBe('SELECT $1, $2');
    expect(pool.calls[0]!.params).toEqual(['k', 'k']);
  });

  it('缺变量 → var-missing，不发查询', async () => {
    const pool = fakePool([]);
    await expect(runSql({ pool, action: { ...base, sql: 'SELECT {{nope}}' } })).rejects.toThrow(/var-missing/);
    expect(pool.calls).toHaveLength(0);
  });

  it('非只读语句被守卫拦下（不发查询）', async () => {
    const pool = fakePool([]);
    await expect(runSql({ pool, action: { ...base, sql: 'DROP TABLE users' } })).rejects.toThrow(/只允许/);
    expect(pool.calls).toHaveLength(0);
  });

  it('连接/语句错误 → SqlError', async () => {
    const pool = fakePool([], { fail: new Error('connection refused') });
    await expect(runSql({ pool, action: { ...base, sql: 'SELECT 1' } })).rejects.toMatchObject({ name: 'SqlError' });
  });

  it('无模板变量时 params 原样下传，SQL 文本不改写', async () => {
    const pool = fakePool([]);
    await runSql({ pool, action: { ...base, sql: 'SELECT * FROM t WHERE id = $1', params: ['7'] } });
    expect(pool.calls[0]!.sql).toBe('SELECT * FROM t WHERE id = $1');
    expect(pool.calls[0]!.params).toEqual(['7']);
  });

  it('params 里也能引用 {{变量}}', async () => {
    const pool = fakePool([]);
    await runSql({ pool, action: { ...base, sql: 'SELECT * FROM t', params: ['{{who}}'] }, vars: { who: 'bob' } });
    expect(pool.calls[0]!.params).toEqual(['bob']);
  });

  it('mysql 下显式 ? 出现在模板之前 → 拒绝（参数顺序不可靠）', async () => {
    const pool = fakePool([], { dialect: 'mysql' });
    await expect(
      runSql({ pool, action: { ...base, sql: 'SELECT ? , {{v}}', params: ['p'] }, vars: { v: 'k' } }),
    ).rejects.toThrow(/sql-params-conflict/);
    expect(pool.calls).toHaveLength(0);
  });

  it('变量名撞关键字（{{update}}）不误杀——守卫跑在绑定后的 SQL 上', async () => {
    const pool = fakePool([]);
    await runSql({ pool, action: { ...base, sql: 'SELECT * FROM t WHERE kind = {{update}}' }, vars: { update: 'x' } });
    expect(pool.calls[0]!.sql).toBe('SELECT * FROM t WHERE kind = $1');
  });

  it('断言命中/不命中：指定列或整行任一单元格', async () => {
    const pool = fakePool([{ status: 'ok' }, { status: 'ok' }]);
    const hit = await runSql({
      pool,
      action: { ...base, sql: 'SELECT 1', assertion: { match: 'contains', expected: 'ok', column: 'status' } },
    });
    expect(hit.assertion?.matched).toBe(true);
    const hitAny = await runSql({
      pool,
      action: { ...base, sql: 'SELECT 1', assertion: { match: 'contains', expected: 'ok' } },
    });
    expect(hitAny.assertion?.matched).toBe(true);
    const miss = await runSql({
      pool,
      action: { ...base, sql: 'SELECT 1', assertion: { match: 'contains', expected: 'nope' } },
    });
    expect(miss.assertion?.matched).toBe(false);
  });

  it('单元格超长截断到 2000 字符', async () => {
    const pool = fakePool([{ big: 'x'.repeat(5000) }]);
    const r = await runSql({ pool, action: { ...base, sql: 'SELECT 1' } });
    expect(String(r.rows[0]!.big)).toHaveLength(2000);
  });

  it('无 dbRef 时 dbRef 为 null', async () => {
    const pool = fakePool([{ a: 1 }]);
    const r = await runSql({ pool, action: { ...base, sql: 'SELECT 1' } });
    expect(r.dbRef).toBeNull();
  });

  it('结果带上实际执行的 SQL 与绑定参数（报告页对照「发了什么/回了什么」）', async () => {
    const pool = fakePool([{ id: 1 }]);
    const r = await runSql({
      pool,
      action: { ...base, sql: 'SELECT * FROM dw WHERE u = {{name}}' },
      vars: { name: 'alice' },
    });
    expect(r.sql).toBe('SELECT * FROM dw WHERE u = $1');
    expect(r.params).toEqual(['alice']);
  });

  it('mysql 方言的 SQL 同样落结果（? 占位符）', async () => {
    const pool = fakePool([{ id: 1 }], { dialect: 'mysql' });
    const r = await runSql({
      pool,
      action: { ...base, sql: 'SELECT * FROM dw WHERE u = {{name}}' },
      vars: { name: 'alice' },
    });
    expect(r.sql).toBe('SELECT * FROM dw WHERE u = ?');
    expect(r.params).toEqual(['alice']);
  });
});

/**
 * Doc-vs-code consistency guard: STEP_DSL_SPEC is the sql-step spec the LLM reads,
 * so its binding rules must match runSql's real semantics.
 *
 * The old copy said "{{var}} must be written into params with ? placeholders, not into the sql text" — the opposite of the code:
 * runSql's tested main path is exactly "{{var}} written directly into the sql text", replaced in order of appearance with positional
 * placeholders bound to values (pinned in sql-query.test.ts); only mixing the two styles is rejected (sql-params-conflict).
 * With wrong copy the AI could never write a sql step carrying variables.
 */
describe('STEP_DSL_SPEC 与 sql 执行器语义一致', () => {
  const SPEC = STEP_DSL_SPEC;
  const sqlLine = SPEC.split('\n').find((l) => l.startsWith('- {"kind":"sql"')) ?? '';

  it('sql 规格写成「变量直接写在 sql 文本里」，形状里不出现 params 字段', () => {
    expect(sqlLine).toContain('{{变量}} 直接写在 sql 文本里');
    expect(sqlLine).toContain('sql-params-conflict');
    expect(sqlLine).not.toContain('"params"');
  });

  it('旧错误措辞不得回潮（与代码相反的旧规则）', () => {
    for (const bad of ['不能写在 sql 文本', '不能写进 sql 文本', '必须写在 params', '变量一律走 params']) {
      expect(SPEC).not.toContain(bad);
    }
  });

  it('queryDb 已下线：规格里不得再出现该 kind', () => {
    expect(SPEC).not.toContain('queryDb');
  });
});
