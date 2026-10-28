import { describe, it, expect } from 'vitest';
import { dialectFromJdbcUrl, resolveDbDialect } from '../src/db-dialect.js';

describe('dialectFromJdbcUrl', () => {
  it('识别 mysql / postgresql 前缀', () => {
    expect(dialectFromJdbcUrl('jdbc:mysql://h:3306/db')).toBe('mysql');
    expect(dialectFromJdbcUrl('jdbc:postgresql://h:5432/db')).toBe('postgres');
  });
  it('大小写与空白不敏感', () => {
    expect(dialectFromJdbcUrl('  JDBC:MYSQL://h/db  ')).toBe('mysql');
  });
  it('认不出的返回 null', () => {
    expect(dialectFromJdbcUrl('jdbc:oracle:thin:@h')).toBeNull();
    expect(dialectFromJdbcUrl('postgres://h/db')).toBeNull();
    expect(dialectFromJdbcUrl(undefined)).toBeNull();
    expect(dialectFromJdbcUrl(123)).toBeNull();
  });
});

describe('resolveDbDialect', () => {
  it('dbType 优先于 url', () => {
    expect(resolveDbDialect({ dbType: 'mysql', url: 'jdbc:mysql://h/db' })).toBe('mysql');
    expect(resolveDbDialect({ dbType: 'postgres', url: 'jdbc:postgresql://h/db' })).toBe('postgres');
  });
  it('缺 dbType 时从 url 推断', () => {
    expect(resolveDbDialect({ url: 'jdbc:mysql://h:3306/db' })).toBe('mysql');
    expect(resolveDbDialect({ url: 'jdbc:postgresql://h:5432/db' })).toBe('postgres');
  });
  it('都没有时回落 postgres', () => {
    expect(resolveDbDialect({ host: 'h' })).toBe('postgres');
    expect(resolveDbDialect(null)).toBe('postgres');
    expect(resolveDbDialect({ dbType: 'oracle' })).toBe('postgres');
  });
  it('fallback 可覆盖', () => {
    expect(resolveDbDialect({}, 'mysql')).toBe('mysql');
  });
});
