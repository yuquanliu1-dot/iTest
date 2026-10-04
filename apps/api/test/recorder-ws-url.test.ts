import { describe, it, expect, afterEach } from 'vitest';
import { buildRecorderWsUrl } from '../src/routes/recorder.js';

const ENV_KEY = 'RECORDER_PUBLIC_WS_URL';
const FALLBACK = 'ws://127.0.0.1:54321/recorder';

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe('buildRecorderWsUrl', () => {
  it('falls back to localhost when unset', () => {
    expect(buildRecorderWsUrl()).toBe(FALLBACK);
  });
  it('uses the configured endpoint as-is', () => {
    process.env[ENV_KEY] = 'ws://192.168.1.10:54321/recorder';
    expect(buildRecorderWsUrl()).toBe('ws://192.168.1.10:54321/recorder');
  });
  it('appends /recorder when path missing', () => {
    process.env[ENV_KEY] = 'ws://192.168.1.10:54321';
    expect(buildRecorderWsUrl()).toBe('ws://192.168.1.10:54321/recorder');
  });
  it('strips trailing slashes', () => {
    process.env[ENV_KEY] = 'ws://192.168.1.10:54321/recorder/';
    expect(buildRecorderWsUrl()).toBe('ws://192.168.1.10:54321/recorder');
  });
  it('accepts wss', () => {
    process.env[ENV_KEY] = 'wss://itest.example.com/recorder';
    expect(buildRecorderWsUrl()).toBe('wss://itest.example.com/recorder');
  });
  it('rejects http scheme and falls back', () => {
    process.env[ENV_KEY] = 'http://192.168.1.10:54321/recorder';
    expect(buildRecorderWsUrl()).toBe(FALLBACK);
  });
  it('rejects garbage and falls back', () => {
    process.env[ENV_KEY] = 'not-a-url';
    expect(buildRecorderWsUrl()).toBe(FALLBACK);
  });
});
