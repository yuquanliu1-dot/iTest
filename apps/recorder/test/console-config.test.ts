import { describe, it, expect } from 'vitest';
import { DEFAULT_CONSOLE_ORIGIN, normalizeConsoleOrigin, originToMatchPattern } from '../modules/console-config.js';

describe('normalizeConsoleOrigin', () => {
  it('accepts plain http origin', () => {
    expect(normalizeConsoleOrigin('http://192.168.1.10:5173')).toBe('http://192.168.1.10:5173');
  });
  it('strips path/query/hash, keeping only origin', () => {
    expect(normalizeConsoleOrigin('http://192.168.1.10:5173/cases/1?x=2#top')).toBe('http://192.168.1.10:5173');
  });
  it('trims whitespace', () => {
    expect(normalizeConsoleOrigin('  http://itest.local:5173  ')).toBe('http://itest.local:5173');
  });
  it('accepts https and default port forms', () => {
    expect(normalizeConsoleOrigin('https://itest.example.com')).toBe('https://itest.example.com');
  });
  it('rejects non-http schemes', () => {
    expect(normalizeConsoleOrigin('ws://192.168.1.10:5173')).toBeNull();
    expect(normalizeConsoleOrigin('ftp://itest.example.com')).toBeNull();
  });
  it('rejects garbage', () => {
    expect(normalizeConsoleOrigin('not a url')).toBeNull();
    expect(normalizeConsoleOrigin('')).toBeNull();
  });
});

describe('originToMatchPattern', () => {
  it('appends path wildcard', () => {
    expect(originToMatchPattern('http://192.168.1.10:5173')).toBe('http://192.168.1.10:5173/*');
  });
  it('works for https domains', () => {
    expect(originToMatchPattern('https://itest.example.com')).toBe('https://itest.example.com/*');
  });
});

describe('DEFAULT_CONSOLE_ORIGIN', () => {
  it('matches dev server default', () => {
    expect(DEFAULT_CONSOLE_ORIGIN).toBe('http://localhost:5173');
  });
});
