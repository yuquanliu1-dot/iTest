import { describe, it, expect } from 'vitest';
import { CLIP_LEN, clipText, clipDeep, shapeStructured, shapeStep } from './executionHistory.service.js';

describe('clipText', () => {
  it('keeps strings at or under the limit', () => {
    expect(clipText('a'.repeat(CLIP_LEN))).toHaveLength(CLIP_LEN);
    expect(clipText('hello')).toBe('hello');
  });
  it('truncates over-limit strings with ellipsis', () => {
    const out = clipText('x'.repeat(1200));
    expect(out).toHaveLength(CLIP_LEN + 1);
    expect(out.endsWith('…')).toBe(true);
  });
  it('honors custom max', () => {
    expect(clipText('abcdef', 3)).toBe('abc…');
  });
});

describe('clipDeep', () => {
  it('clips nested strings and slices long arrays to 20', () => {
    const v = { a: 'y'.repeat(1500), list: Array.from({ length: 30 }, (_, i) => ({ i })) };
    const out = clipDeep(v) as { a: string; list: unknown[] };
    expect(out.a.endsWith('…')).toBe(true);
    expect(out.a).toHaveLength(CLIP_LEN + 1);
    expect(out.list).toHaveLength(20);
  });
  it('passes through primitives and null', () => {
    expect(clipDeep(null)).toBeNull();
    expect(clipDeep(42)).toBe(42);
    expect(clipDeep(true)).toBe(true);
  });
  it('tolerates rca/preflight/datasetSnapshot-like jsonb shapes', () => {
    const rca = { status: 'analyzed', conclusion: 'z'.repeat(2000), evidence: [1, 'q'.repeat(1500)] };
    const out = clipDeep(rca) as { status: string; conclusion: string; evidence: unknown[] };
    expect(out.status).toBe('analyzed');
    expect(out.conclusion.endsWith('…')).toBe(true);
    expect((out.evidence[1] as string).endsWith('…')).toBe(true);
  });
});

describe('shapeStructured (老报告缺字段容错)', () => {
  it('returns empty object for steps without structured results', () => {
    expect(shapeStructured({})).toEqual({});
    expect(shapeStructured({ db: 'not-an-object', sql: 42, log: null })).toEqual({});
  });
  it('shapes db result: rows>10 → 10 rows + truncated, cell strings clipped', () => {
    const s = {
      db: {
        rowCount: 15,
        durationMs: 120,
        rows: Array.from({ length: 15 }, (_, i) => ({ id: i, note: 'n'.repeat(1500) })),
        assertion: { matched: true, expected: 'e'.repeat(2000) },
      },
    };
    const out = shapeStructured(s);
    expect(out.db).toBeDefined();
    expect(out.db!.rowCount).toBe(15);
    expect(out.db!.rows).toHaveLength(10);
    expect(out.db!.truncated).toBe(true);
    expect((out.db!.rows[0] as { note: string }).note.endsWith('…')).toBe(true);
    expect(out.db!.assertion!.matched).toBe(true);
    expect(out.db!.assertion!.expected!.endsWith('…')).toBe(true);
  });
  it('shapes sql result with dbRef; non-array rows tolerated', () => {
    const out = shapeStructured({ sql: { dbRef: 'main', rowCount: 1, durationMs: 5, rows: 'garbage' } });
    expect(out.sql!.dbRef).toBe('main');
    expect(out.sql!.rows).toEqual([]);
    expect(out.sql!.truncated).toBeUndefined();
  });
  it('carries the executed SQL + bound params through for db/sql;老报告缺省则不带这两个键', () => {
    const out = shapeStructured({
      sql: { dbRef: 'main', rowCount: 1, durationMs: 5, rows: [], sql: 'SELECT * FROM t WHERE u = $1', params: ['alice'] },
      db: { rowCount: 1, durationMs: 5, rows: [], sql: 'SELECT "id" FROM "reports" LIMIT 10', params: [] },
    });
    expect(out.sql!.sql).toBe('SELECT * FROM t WHERE u = $1');
    expect(out.sql!.params).toEqual(['alice']);
    expect(out.db!.sql).toBe('SELECT "id" FROM "reports" LIMIT 10');
    expect(out.db!.params).toEqual([]);
    // 老报告无这两个字段 → 不产生空串/空数组（否则前端会渲染一个空的「实际执行的 SQL」块）
    const legacy = shapeStructured({ sql: { dbRef: 'main', rowCount: 1, durationMs: 5, rows: [] } });
    expect(legacy.sql!.sql).toBeUndefined();
    expect(legacy.sql!.params).toBeUndefined();
  });
  it('shapes log result: lines>10 → 10 lines + truncated; non-object lines coerced to raw', () => {
    const s = { log: { matchedLineCount: 12, durationMs: 8, lines: [...Array.from({ length: 12 }, (_, i) => ({ ts: `t${i}`, raw: 'r'.repeat(1200) })), 'plain'] } };
    const out = shapeStructured(s);
    expect(out.log!.lines).toHaveLength(10);
    expect(out.log!.truncated).toBe(true);
    expect(out.log!.lines[0]!.raw!.endsWith('…')).toBe(true);
  });
  it('shapes http result: request/response clipped, saved passed through, missing response tolerated', () => {
    const s = {
      http: {
        request: { method: 'POST', url: 'http://x', headers: { Host: 'h'.repeat(1500) }, bodyPreview: 'b'.repeat(1500) },
        response: { status: 200, statusText: 'OK', durationMs: 12, bodyText: 'r'.repeat(1500) },
        transportFailure: 'f'.repeat(1500),
        assertion: { matched: false, statusExpected: 200 },
        saved: { varName: 'v', value: 's'.repeat(1500) },
      },
    };
    const out = shapeStructured(s);
    expect(out.http!.request.method).toBe('POST');
    expect((out.http!.request.headers as { Host: string }).Host.endsWith('…')).toBe(true);
    expect(out.http!.request.bodyPreview!.endsWith('…')).toBe(true);
    expect(out.http!.response!.status).toBe(200);
    expect(out.http!.response!.bodyText.endsWith('…')).toBe(true);
    expect(out.http!.transportFailure!.endsWith('…')).toBe(true);
    expect(out.http!.assertion!.statusExpected).toBe(200);
    expect(out.http!.saved!.value.endsWith('…')).toBe(true);

    const noRes = shapeStructured({ http: { request: { method: 'GET', url: 'u' } } });
    expect(noRes.http!.response).toBeUndefined();
  });
  it('shapes syslog result with packet clipped', () => {
    const out = shapeStructured({ syslog: { protocol: 'rfc5424', host: 'h', port: 514, facility: 'user', severity: 'info', packet: 'p'.repeat(1500), durationMs: 3, bytes: 1500 } });
    expect(out.syslog!.packet.endsWith('…')).toBe(true);
    expect(out.syslog!.port).toBe(514);
  });
});

describe('shapeStep', () => {
  it('old-report minimal step: only base fields, optional keys absent', () => {
    const out = shapeStep({ order: 2, status: 'passed', durationMs: 50 });
    expect(out).toEqual({ order: 2, status: 'passed', durationMs: 50 });
    expect('startedAt' in out).toBe(false);
    expect('warning' in out).toBe(false);
    expect('hitLocator' in out).toBe(false);
    expect('visionAssert' in out).toBe(false);
    expect('aiUsage' in out).toBe(false);
  });
  it('tolerates garbage input without throwing', () => {
    const out = shapeStep({});
    expect(out.order).toBe(0);
    expect(out.status).toBe('unknown');
  });
  it('clips long error/humanMessage/warning at 1000', () => {
    const out = shapeStep({ order: 1, status: 'failed', durationMs: 1, error: 'e'.repeat(1500), humanMessage: 'h'.repeat(1500), warning: 'w'.repeat(1500) });
    expect(out.error!.endsWith('…')).toBe(true);
    expect(out.humanMessage!.endsWith('…')).toBe(true);
    expect(out.warning!.endsWith('…')).toBe(true);
  });
  it('shapes hitLocator / visionAssert; visionAssert without reason omitted', () => {
    const out = shapeStep({ order: 1, status: 'failed', durationMs: 1, hitLocator: { kind: 'css', value: 'v'.repeat(1500) }, visionAssert: { passed: false, reason: 'r'.repeat(1500), expected: 'ex', screenshot: 'should-not-leak' } });
    expect(out.hitLocator).toEqual({ kind: 'css', value: `${'v'.repeat(CLIP_LEN)}…` });
    expect(out.visionAssert!.passed).toBe(false);
    expect(out.visionAssert!.reason.endsWith('…')).toBe(true);
    expect(out.visionAssert!.expected).toBe('ex');
    expect(JSON.stringify(out)).not.toContain('should-not-leak');

    const noReason = shapeStep({ order: 1, status: 'passed', durationMs: 1, visionAssert: { passed: true } });
    expect('visionAssert' in noReason).toBe(false);
  });
  it('aiUsage included only when calls is numeric; screenshot/compiled never leaked', () => {
    const withAu = shapeStep({ order: 1, status: 'passed', durationMs: 1, aiUsage: { calls: 3, promptTokens: 100, modelCallMs: 9.5 }, screenshot: 'base64', compiled: [{ kind: 'click' }] });
    expect(withAu.aiUsage).toEqual({ calls: 3, promptTokens: 100, modelCallMs: 9.5 });
    const body = JSON.stringify(withAu);
    expect(body).not.toContain('base64');
    expect(body).not.toContain('compiled');
    const noAu = shapeStep({ order: 1, status: 'passed', durationMs: 1, aiUsage: { promptTokens: 5 } });
    expect('aiUsage' in noAu).toBe(false);
  });
  it('merges structured results via shapeStructured', () => {
    const out = shapeStep({ order: 3, status: 'passed', durationMs: 10, db: { rowCount: 0, durationMs: 1, rows: [] } });
    expect(out.db).toBeDefined();
    expect(out.db!.rows).toEqual([]);
  });
});
