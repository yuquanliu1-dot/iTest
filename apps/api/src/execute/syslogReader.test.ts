import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';

const execMock = vi.fn();
const connectMock = vi.fn();
const endMock = vi.fn();

vi.mock('ssh2', () => ({
  Client: class FakeClient extends EventEmitter {
    connect(cfg: unknown) {
      connectMock(cfg);
      // Default: emit 'ready' so happy-path calls resolve.
      // Tests that want an error override this method on the prototype.
      const self = this as unknown as FakeClient;
      queueMicrotask(() => self.emit('ready'));
    }
    exec(cmd: string, cb: (err: null, ch: unknown) => void) {
      execMock(cmd);
      const stream = new EventEmitter() as EventEmitter & { read: () => Buffer | null; stderr: EventEmitter };
      (stream as unknown as { read: () => Buffer | null }).read = () => null;
      (stream as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
      cb(null, stream);
    }
    end() { endMock(); }
  },
}));

import { runObserveLog, SyslogConnectFailed, SyslogFileMissing } from './syslogReader.js';

describe('runObserveLog', () => {
  beforeEach(() => {
    execMock.mockReset();
    connectMock.mockReset();
    endMock.mockReset();
  });

  it('connects with privateKey and execs a tail + awk pipeline', async () => {
    const { Client } = await import('ssh2');
    const Orig = (Client as unknown as { new (): EventEmitter });
    const originalExec = Orig.prototype.exec;

    // Override exec for this test only so we can feed output and close the stream.
    (Orig.prototype as unknown as { exec: (cmd: string, cb: (err: null, ch: unknown) => void) => void }).exec = function (
      cmd: string,
      cb: (err: null, ch: unknown) => void,
    ) {
      execMock(cmd);
      const stream = new EventEmitter() as EventEmitter & { read: () => Buffer | null; stderr: EventEmitter };
      (stream as unknown as { read: () => Buffer | null }).read = () => null;
      (stream as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
      cb(null, stream);
      queueMicrotask(() => {
        stream.emit('data', Buffer.from('2026-10-03T10:00:00Z login ok for user=alice\n2026-10-03T10:00:01Z session opened\n'));
        stream.emit('close');
      });
    };

    try {
      const env = {
        host: '10.0.0.5',
        port: 22,
        user: 'itest',
        privateKey: Buffer.from('FAKEKEY'),
        filePath: '/var/log/syslog',
      };
      const action = {
        kind: 'observeLog' as const,
        windowMs: 60000,
        keywords: ['login'],
        fromLine: 200,
      };
      const since = new Date('2026-10-03T09:00:00Z');

      const result = await runObserveLog({ env, action, since });

      expect(connectMock).toHaveBeenCalledTimes(1);
      const cfg = connectMock.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(cfg.host).toBe('10.0.0.5');
      expect(cfg.port).toBe(22);
      expect(cfg.username).toBe('itest');
      expect(cfg.privateKey).toBe(env.privateKey);

      expect(execMock).toHaveBeenCalledTimes(1);
      const cmd = execMock.mock.calls[0]?.[0] as string;
      expect(cmd.startsWith('tail -n 200')).toBe(true);
      expect(cmd).toContain('awk');
      expect(cmd).toContain('grep');

      expect(endMock).toHaveBeenCalledTimes(1);
      expect(result.matchedLineCount).toBe(2);
      expect(result.lines[0]?.ts).toBe('2026-10-03T10:00:00Z');
    } finally {
      (Orig.prototype as unknown as { exec: typeof originalExec }).exec = originalExec;
    }
  });

  it('throws SyslogConnectFailed when ssh2 emits error', async () => {
    const { Client } = await import('ssh2');
    const Orig = (Client as unknown as { new (): EventEmitter });
    const originalConnect = Orig.prototype.connect;
    (Orig.prototype as unknown as { connect: (cfg: unknown) => void }).connect = function (cfg: unknown) {
      connectMock(cfg);
      const self = this as unknown as EventEmitter;
      queueMicrotask(() => {
        self.emit('error', new Error('connection refused'));
      });
    };

    try {
      await expect(
        runObserveLog({
          env: { host: 'h', port: 22, user: 'u', privateKey: Buffer.from('k'), filePath: '/var/log/x' },
          action: { kind: 'observeLog' as const, windowMs: 60000, keywords: [], fromLine: 200 },
          since: new Date('2026-10-03T09:00:00Z'),
        }),
      ).rejects.toBeInstanceOf(SyslogConnectFailed);
    } finally {
      (Orig.prototype as unknown as { connect: typeof originalConnect }).connect = originalConnect;
    }
  });

  it('exports SyslogFileMissing error class', () => {
    expect(SyslogFileMissing).toBeDefined();
    const e = new SyslogFileMissing('/var/log/missing.log');
    expect(e.name).toBe('SyslogFileMissing');
    expect(e.message).toContain('/var/log/missing.log');
  });
});
