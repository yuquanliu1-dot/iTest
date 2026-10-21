import { describe, it, expect } from 'vitest';
import { assertReadOnlySql } from '../src/execute/sqlGuard.js';

describe('assertReadOnlySql', () => {
  it('放行 SELECT / WITH（含小写、带注释、带 CTE）', () => {
    for (const s of [
      'SELECT 1',
      'select id from users where id = $1',
      '  \n SELECT * FROM t LIMIT 10',
      'WITH recent AS (SELECT id FROM orders WHERE ts > now()) SELECT * FROM recent',
      'SELECT /* hint */ 1',
      "SELECT 'a; b' FROM t",
      "SELECT 'delete from t' FROM t",
      'SELECT name FROM users -- ; drop table x',
    ]) expect(() => assertReadOnlySql(s)).not.toThrow();
  });

  it('拒绝非 SELECT/WITH 开头', () => {
    for (const s of ['INSERT INTO t VALUES (1)', 'UPDATE t SET a=1', 'DELETE FROM t', 'DROP TABLE t', 'TRUNCATE t', 'CALL p()']) {
      expect(() => assertReadOnlySql(s)).toThrow(/只允许 SELECT|只读/);
    }
  });

  it('拒绝多语句（字符串字面量与注释里的分号不算）', () => {
    expect(() => assertReadOnlySql('SELECT 1; DROP TABLE users')).toThrow(/多语句|只读/);
    expect(() => assertReadOnlySql('SELECT 1;\nSELECT 2')).toThrow(/多语句|只读/);
  });

  it('拒绝 SELECT ... INTO（写文件/建表语义），合法子查询形态不误杀', () => {
    expect(() => assertReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x INTO OUTFILE '/tmp/x'")).toThrow(/INTO|只读/);
    expect(() => assertReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x WHERE 1 IN (SELECT 1 FROM generate_series(1,2))")).not.toThrow();
    expect(() => assertReadOnlySql("SELECT * FROM t WHERE a = 'create table'")).not.toThrow();
  });

  it('拒绝超长语句', () => {
    expect(() => assertReadOnlySql(`SELECT ${'a'.repeat(9000)}`)).toThrow(/长度/);
  });

  it('空语句拒绝', () => {
    expect(() => assertReadOnlySql('')).toThrow();
    expect(() => assertReadOnlySql('   ')).toThrow();
  });
});
