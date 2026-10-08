import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { deriveConsoleOrigin, originToMatchPattern } from '../src/routes/recorder.js';

function mockReq(headers: Record<string, string | string[] | undefined>): Request {
  // express 的 Request.header 期望 Record<string, string|string[]>；这里手工构造一个最小 req
  return { headers } as unknown as Request;
}

describe('originToMatchPattern', () => {
  it('appends /* to origin', () => {
    expect(originToMatchPattern('http://192.168.30.228:8080')).toBe('http://192.168.30.228:8080/*');
  });
  it('works for https', () => {
    expect(originToMatchPattern('https://itest.example.com')).toBe('https://itest.example.com/*');
  });
});

describe('deriveConsoleOrigin', () => {
  it('prefers Origin header when present', () => {
    const req = mockReq({
      origin: 'http://192.168.30.228:8080',
      referer: 'http://other.example.com/foo',
      host: 'ignored.example.com:54321',
      'x-forwarded-proto': 'https',
    });
    expect(deriveConsoleOrigin(req)).toBe('http://192.168.30.228:8080');
  });

  it('falls back to Referer when Origin absent', () => {
    const req = mockReq({
      referer: 'http://192.168.30.228:8080/cases/123?x=1',
      host: 'api.internal:54321',
      'x-forwarded-proto': 'http',
    });
    expect(deriveConsoleOrigin(req)).toBe('http://192.168.30.228:8080');
  });

  it('falls back to Host + X-Forwarded-Proto when no Origin/Referer', () => {
    const req = mockReq({
      host: '192.168.30.228:8080',
      'x-forwarded-proto': 'http',
    });
    expect(deriveConsoleOrigin(req)).toBe('http://192.168.30.228:8080');
  });

  it('honors https in X-Forwarded-Proto', () => {
    const req = mockReq({
      host: 'itest.example.com',
      'x-forwarded-proto': 'https',
    });
    expect(deriveConsoleOrigin(req)).toBe('https://itest.example.com');
  });

  it('handles comma-separated X-Forwarded-Proto (nginx may prepend)', () => {
    const req = mockReq({
      host: 'itest.example.com',
      'x-forwarded-proto': 'https,http',
    });
    expect(deriveConsoleOrigin(req)).toBe('https://itest.example.com');
  });

  it('returns null when nothing usable is present', () => {
    const req = mockReq({});
    expect(deriveConsoleOrigin(req)).toBeNull();
  });

  it('ignores malformed Origin and falls back to Referer', () => {
    const req = mockReq({
      origin: 'not a url',
      referer: 'http://192.168.30.228:8080/',
    });
    expect(deriveConsoleOrigin(req)).toBe('http://192.168.30.228:8080');
  });
});
