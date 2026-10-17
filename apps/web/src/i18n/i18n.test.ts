import { describe, expect, it } from 'vitest';
import { localizeApiError } from './index';

describe('localizeApiError', () => {
  it('命中错误码目录返回本地化文案（默认 zh-CN）', () => {
    expect(localizeApiError({ code: 'forbidden' })).toBe('需要管理员或更高权限');
  });

  it('未知 code 回落原始 message', () => {
    expect(localizeApiError({ code: 'zzz', message: 'M' })).toBe('M');
  });

  it('空输入返回空串', () => {
    expect(localizeApiError(null)).toBe('');
    expect(localizeApiError({ message: 'raw' })).toBe('raw');
  });
});