import { describe, it, expect } from 'vitest';
import { dialectFromJdbcUrl, resolveDbDialect, defaultDbPort } from '../src/db-dialect.js';

describe('dialectFromJdbcUrl', () => {
  it('识别 mysql / postgresql 前缀', () => {
    expect(dialectFromJdbcUrl('jdbc:mysql://h:3306/db')).toBe('mysql');
    expect(dialectFromJdbcUrl('jdbc:postgresql://h:5432/db')).toBe('postgres');
  });
  it('识别 gauss100（zenith）前缀：无 //，@ 直跟 host', () => {
    expect(dialectFromJdbcUrl('jdbc:zenith:@192.168.2.60:2888')).toBe('gauss100');
    expect(dialectFromJdbcUrl(' JDBC:ZENITH:@h:2888 ')).toBe('gauss100');
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
    expect(resolveDbDialect({ dbType: 'gauss100', url: 'jdbc:zenith:@h:2888' })).toBe('gauss100');
  });
  it('缺 dbType 时从 url 推断', () => {
    expect(resolveDbDialect({ url: 'jdbc:mysql://h:3306/db' })).toBe('mysql');
    expect(resolveDbDialect({ url: 'jdbc:postgresql://h:5432/db' })).toBe('postgres');
    expect(resolveDbDialect({ url: 'jdbc:zenith:@h:2888' })).toBe('gauss100');
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

describe('defaultDbPort', () => {
  it('postgres/mysql/gauss100 各自默认端口', () => {
    expect(defaultDbPort('postgres')).toBe(5432);
    expect(defaultDbPort('mysql')).toBe(3306);
    expect(defaultDbPort('gauss100')).toBe(2888);
  });
});
