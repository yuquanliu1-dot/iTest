import { describe, it, expect } from 'vitest';
import { ApiError } from './client';

describe('ApiError code', () => {
  it('透传后端稳定错误码 body.error', () => {
    const err = new ApiError(403, '需要管理员角色', 'forbidden');
    expect(err.code).toBe('forbidden');
    expect(err.status).toBe(403);
    expect(err.message).toBe('需要管理员角色');
  });

  it('未带码时 code 为 undefined', () => {
    const err = new ApiError(500, 'HTTP 500');
    expect(err.code).toBeUndefined();
  });
});