import { describe, it, expect } from 'vitest';
import { WindowStrategy, FailureReason } from '../src/playback.js';

describe('playback shared types', () => {
  it('WindowStrategy accepts known values', () => {
    expect(WindowStrategy.parse('maximize')).toBe('maximize');
    expect(WindowStrategy.parse('current')).toBe('current');
    expect(WindowStrategy.parse('custom')).toBe('custom');
  });
  it('WindowStrategy rejects unknown', () => {
    expect(() => WindowStrategy.parse('huge')).toThrow();
  });
  it('FailureReason enum exposes expected names', () => {
    const all = FailureReason.options;
    expect(all).toContain('URLUnreachable');
    expect(all).toContain('DisabledTimeout');
    expect(all).toContain('CDPUnavailable');
  });
});
