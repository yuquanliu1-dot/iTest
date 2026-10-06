import { describe, it, expect } from 'vitest';
import { maskSensitiveValues } from '../src/execute/cdp.js';

describe('maskSensitiveValues', () => {
  it('把文本中出现的敏感变量值替换为 ******', () => {
    const vars = { password: 's3cret-Pw', username: 'alice' };
    const text = 'assertText failed: expected "s3cret-Pw", actual "bad"';
    expect(maskSensitiveValues(text, vars, ['password'])).toBe(
      'assertText failed: expected "******", actual "bad"',
    );
  });

  it('只打码 sensitiveVarKeys 中的变量，非敏感值不动', () => {
    const vars = { password: 'pw', username: 'alice' };
    expect(maskSensitiveValues('alice/pw', vars, ['password'])).toBe('alice/******');
    expect(maskSensitiveValues('alice/pw', vars, [])).toBe('alice/pw');
  });

  it('值多次出现全部替换；空 keys / 空值原样返回', () => {
    expect(maskSensitiveValues('a a a', { a: 'a' }, ['a'])).toBe('****** ****** ******');
    expect(maskSensitiveValues('x', { a: '' }, ['a'])).toBe('x');
    expect(maskSensitiveValues('x', {}, [])).toBe('x');
  });
});
