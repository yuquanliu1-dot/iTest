import { Client } from 'ssh2';
import type { ObserveLogAction } from '@itest/shared';
import type { SyslogCtx } from './envContext.js';

export class SyslogConnectFailed extends Error {
  constructor(cause: string) {
    super(`syslog connect failed: ${cause}`);
    this.name = 'SyslogConnectFailed';
  }
}
export class SyslogAuthFailed extends Error {
  constructor() {
    super('syslog auth failed');
    this.name = 'SyslogAuthFailed';
  }
}
export class SyslogFileMissing extends Error {
  constructor(p: string) {
    super(`syslog file not accessible: ${p}`);
    this.name = 'SyslogFileMissing';
  }
}
export class SyslogTimeout extends Error {
  constructor() {
    super('syslog command timeout');
    this.name = 'SyslogTimeout';
  }
}

export interface ObserveLogLineResult {
  matchedLineCount: number;
  durationMs: number;
  lines: { ts?: string; raw: string }[];
  truncated?: boolean;
  assertion?: { matched: boolean; expected: string; match: 'equals' | 'contains' | 'regex' };
}

const TRUNCATE = 50;
const TIMEOUT_MS = 15_000;

/** Connects per authType: password passes password, key passes privateKey (ssh2 natively supports both). */
function connectSsh(env: SyslogCtx): Promise<Client> {
  const client = new Client();
  return new Promise((resolve, reject) => {
    client.once('ready', () => resolve(client));
    // ssh2 socket errors often carry only a code (e.g. ECONNREFUSED) with an empty message → join both for readability
    client.once('error', (err) => {
      const code = (err as { code?: string }).code;
      const detail = [err.message, code].filter(Boolean).join(' ') || 'connection failed';
      reject(
        err.message.toLowerCase().includes('auth')
          ? new SyslogAuthFailed()
          : new SyslogConnectFailed(detail),
      );
    });
    client.connect({
      host: env.host,
      port: env.port,
      username: env.user,
      ...(env.authType === 'password'
        ? { password: env.password ?? '' }
        : { privateKey: env.privateKey! }),
      readyTimeout: 8000,
    });
  });
}

/** Connectivity probe: connect → tail -n 1 to verify the file is readable → end. Returns elapsed ms. */
export async function probeSyslog(env: SyslogCtx): Promise<number> {
  const client = await connectSsh(env);
  const startedAt = Date.now();
  try {
    await new Promise<void>((resolve, reject) => {
      let stderr = '';
      const timer = setTimeout(() => reject(new SyslogTimeout()), TIMEOUT_MS);
      client.exec(`tail -n 1 '${env.filePath}'`, (err, ch) => {
        if (err) {
          clearTimeout(timer);
          reject(new SyslogFileMissing(err.message));
          return;
        }
        ch.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
        // The probe does not care about stdout content, but a data listener must be attached to switch the stream to
        // flowing mode: an ssh2 channel is a readable stream; with nobody consuming it, stdout backpressures → close
        // never fires → every probe waits out the full 15s timeout (observed on prod228, 2026-10-22).
        ch.on('data', () => { /* Discard: the probe only verifies the file is readable */ });
        ch.on('close', (code: number | null) => {
          clearTimeout(timer);
          if (code !== 0) reject(new SyslogFileMissing(stderr.trim() || env.filePath));
          else resolve();
        });
        ch.on('error', (e: Error) => {
          clearTimeout(timer);
          reject(new SyslogFileMissing(e.message));
        });
      });
    });
    return Date.now() - startedAt;
  } finally {
    client.end();
  }
}

export async function runObserveLog(opts: {
  env: SyslogCtx;
  action: ObserveLogAction;
  since: Date;
}): Promise<ObserveLogLineResult> {
  const { env, action, since } = opts;
  const client = await connectSsh(env);

  const sinceIso = since.toISOString();
  const kwPattern = action.keywords
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const cmd = [
    `tail -n ${action.fromLine} '${env.filePath}'`,
    `awk -v since="${sinceIso}" '$1 >= since'`,
    kwPattern ? `grep -Ei '${kwPattern}'` : 'cat',
  ].join(' | ');

  const t0 = Date.now();
  const raw = await new Promise<string>((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new SyslogTimeout()), TIMEOUT_MS);
    client.exec(cmd, (err, ch) => {
      if (err) {
        clearTimeout(timer);
        reject(new SyslogFileMissing(err.message));
        return;
      }
      ch.on('data', (d: Buffer) => {
        buf += d.toString('utf8');
      });
      ch.on('close', () => {
        clearTimeout(timer);
        resolve(buf);
      });
      ch.on('error', (e: Error) => {
        clearTimeout(timer);
        reject(new SyslogFileMissing(e.message));
      });
      ch.stderr.on('data', (d: Buffer) => {
        /* swallow */ void d;
      });
    });
  });

  client.end();
  const durationMs = Date.now() - t0;
  let lines = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(' ');
      if (space > 0 && /^\d{4}-\d{2}-\d{2}T/.test(line.slice(0, space))) {
        return { ts: line.slice(0, space), raw: line };
      }
      return { raw: line };
    });

  const truncated = lines.length > TRUNCATE;
  if (truncated) lines = lines.slice(0, TRUNCATE);

  let assertion: ObserveLogLineResult['assertion'];
  if (action.assertion) {
    assertion = {
      matched: lines.some((l) =>
        matchesOne(l.raw, action.assertion!.match, action.assertion!.expected),
      ),
      expected: action.assertion.expected,
      match: action.assertion.match,
    };
  }

  return {
    matchedLineCount: lines.length,
    durationMs,
    lines,
    ...(truncated ? { truncated: true } : {}),
    assertion,
  };
}

function matchesOne(s: string, match: 'equals' | 'contains' | 'regex', expected: string): boolean {
  if (match === 'equals') return s === expected;
  if (match === 'contains') return s.includes(expected);
  if (match === 'regex') {
    try {
      return new RegExp(expected).test(s);
    } catch {
      return false;
    }
  }
  return false;
}
