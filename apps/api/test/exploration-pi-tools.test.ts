/**
 * pi exploration tool layer (P3) unit tests: gates, sandbox, ledgers, evidence frame persistence.
 *
 * Coverage:
 *  - click destructive gate (default deny / explicit authorization allows) + fragile selector gate;
 *  - fill credential placeholder substitution (trail records only the original value) + readback mismatch feedback + missing credentials → fatal error callback;
 *  - evaluate three-layer sandbox: L1 (static-scan rejection) and L3 (return value cap/serialization) gates;
 *  - C1 coverage ledger (path dedupe/interaction counts/feed-back digest) + terminal coverage digest (how much covered / what's missing);
 *  - D3 error signals (console/HTTP collection, incremental drain, cap);
 *  - A1 evidence frame: finding persisted with evidence_frame, duplicate entry dedupe, trail segment cleared after successful persist;
 *  - trailStepOf action trail shape (legacy vocabulary alignment: sql/repo/press/wait…).
 *
 * Tools are driven by a fake page (only the methods tools actually call); finding persistence goes through real PG (column shapes must be real).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import type { Page } from 'playwright-core';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

/** Fake page: provides only the methods tools actually call, and records actions. */
interface FakePageOpts {
  url?: string;
  /** Return value of locator().first().evaluate() (click reads element info; fill reads the dropdown-expanded check). */
  locatorEvaluateResult?: unknown;
  /** Readback value of locator().first().inputValue(). */
  inputValue?: string;
  /** Return value of page.evaluate() (evaluate tool). */
  evaluateResult?: unknown;
}

function makeFakePage(opts: FakePageOpts = {}) {
  const calls: { clicks: string[]; typed: string[]; tab: number; evaluated: number } = {
    clicks: [],
    typed: [],
    tab: 0,
    evaluated: 0,
  };
  const locator = (sel: string) => {
    const loc = {
      evaluate: async () => opts.locatorEvaluateResult ?? false,
      click: async () => {
        calls.clicks.push(sel);
      },
      fill: async () => undefined,
      pressSequentially: async (v: string) => {
        calls.typed.push(v);
      },
      inputValue: async () => opts.inputValue ?? '',
      waitFor: async () => undefined,
      selectOption: async () => undefined,
      innerText: async () => '文本',
    };
    return { ...loc, first: () => loc };
  };
  const page = {
    url: () => opts.url ?? 'http://sut.example.com/app/assets',
    viewportSize: () => ({ width: 1280, height: 800 }),
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
    evaluate: async () => {
      calls.evaluated += 1;
      return opts.evaluateResult;
    },
    screenshot: async () => {
      throw new Error('本用例不截图');
    },
    keyboard: {
      press: async () => {
        calls.tab += 1;
      },
    },
    mouse: { wheel: async () => undefined },
    locator,
    on: () => undefined,
    off: () => undefined,
  };
  return { page: page as unknown as Page, calls };
}

let pool: Pool;
let projectId: string;
let versionId: string;
let userId: string;
let findingsMod: typeof import('../src/pi/exploration/findings.js');
let sessionCounter = 0;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  const seed = await seedProject(pool);
  projectId = seed.projectId;
  versionId = seed.versionId;
  userId = seed.userId;
  findingsMod = await import('../src/pi/exploration/findings.js');
}, 60000);

afterAll(async () => {
  const { pool: p } = await import('../src/db/client.js');
  await p.end().catch(() => undefined);
  await pool.end();
});

/** Insert a session row (findings reference it via foreign key). */
async function insertSession(): Promise<string> {
  sessionCounter += 1;
  const r = await pool.query(
    `INSERT INTO exploration_sessions(project_id, version_id, title, charter, persona, status, created_by_user_id)
     VALUES ($1,$2,$3,'探索用户管理页','qa','pending',$4) RETURNING id`,
    [projectId, versionId, `pi 工具单测 ${sessionCounter}`, userId],
  );
  return r.rows[0]!.id as string;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('pi 探索工具层', () => {
  it('click 破坏性闸：默认拒（不点），显式授权才放行', async () => {
    const { createClickTool } = await import('../src/pi/exploration/tools/browser.js');
    const fake = makeFakePage({ locatorEvaluateResult: { text: '删除该资产', placeholder: '', value: '' } });

    const denied = createClickTool({
      page: fake.page,
      vision: true,
      scopeOrigins: ['http://sut.example.com'],
    });
    const r1 = await denied.execute('c1', { target: '#del-btn' });
    expect(r1.isError).toBe(true);
    expect(JSON.stringify(r1.content)).toContain('破坏性');
    expect(fake.calls.clicks).toHaveLength(0);

    const allowed = createClickTool({
      page: fake.page,
      vision: true,
      scopeOrigins: ['http://sut.example.com'],
      allowDestructive: true,
    });
    const r2 = await allowed.execute('c2', { target: '#del-btn' });
    expect(r2.isError).toBeFalsy();
    expect(fake.calls.clicks).toEqual(['#del-btn']);
  }, 20000);

  it('脆弱 selector 闸：XPath/位置链事前拒收（不碰页面）', async () => {
    const { createClickTool, createFillTool } = await import('../src/pi/exploration/tools/browser.js');
    const fake = makeFakePage();
    const click = createClickTool({ page: fake.page, vision: true, scopeOrigins: ['http://sut.example.com'] });
    const fill = createFillTool({ page: fake.page, vision: true, scopeOrigins: ['http://sut.example.com'] });

    const r1 = await click.execute('c1', { target: '//button[1]' });
    expect(r1.isError).toBe(true);
    expect(JSON.stringify(r1.content)).toContain('脆弱 selector');
    const r2 = await fill.execute('f1', { target: 'div:nth-child(2)' });
    expect(r2.isError).toBe(true);
    expect(fake.calls.clicks).toHaveLength(0);
    expect(fake.calls.typed).toHaveLength(0);
  }, 20000);

  it('fill 凭据占位符：替换后写入真实值；回读不一致只报长度（不回显凭据）', async () => {
    const { createFillTool } = await import('../src/pi/exploration/tools/browser.js');
    const fake = makeFakePage({ inputValue: 'wy' });
    const fill = createFillTool({
      page: fake.page,
      vision: true,
      scopeOrigins: ['http://sut.example.com'],
      valueSub: (v) => (v === '__ITEST_USERNAME__' ? 'wy' : v),
    });

    const ok = await fill.execute('f1', { target: '#user', value: '__ITEST_USERNAME__' });
    expect(ok.isError).toBeFalsy();
    expect(fake.calls.typed).toEqual(['wy']);
    expect(JSON.stringify(ok.content)).toContain('占位符已替换');

    // Readback differs (and a substitution happened) → feedback gives only the length, never echoes the real value.
    const mismatch = makeFakePage({ inputValue: 'other' });
    const fill2 = createFillTool({
      page: mismatch.page,
      vision: true,
      scopeOrigins: ['http://sut.example.com'],
      valueSub: (v) => (v === '__ITEST_USERNAME__' ? 'wy' : v),
    });
    const bad = await fill2.execute('f2', { target: '#user', value: '__ITEST_USERNAME__' });
    expect(bad.isError).toBe(true);
    const text = JSON.stringify(bad.content);
    expect(text).toContain('实际值长度 5');
    expect(text).not.toContain('wy');
  }, 20000);

  it('fill 缺凭据 → 终止性错误回调（onFatal）+ isError（工具不 throw）', async () => {
    const { createFillTool } = await import('../src/pi/exploration/tools/browser.js');
    const fake = makeFakePage();
    const onFatal = vi.fn();
    const fill = createFillTool({
      page: fake.page,
      vision: true,
      scopeOrigins: ['http://sut.example.com'],
      valueSub: () => {
        const e = new Error('env-missing: 环境未配置用户名/密码');
        e.name = 'EnvMissing';
        throw e;
      },
      onFatal,
    });

    const r = await fill.execute('f1', { target: '#user', value: '__ITEST_USERNAME__' });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('env-missing');
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(fake.calls.typed).toHaveLength(0);
  }, 20000);

  it('evaluate 沙箱：L1 静态扫描拒收网络/存储/导航；L3 返回值封顶 32KB', async () => {
    const { createEvaluateTool } = await import('../src/pi/exploration/tools/evaluate.js');
    const fake = makeFakePage({ evaluateResult: { ok: 1 } });
    const tool = createEvaluateTool({ page: fake.page });

    for (const expr of ["fetch('/api/x')", 'document.cookie', 'localStorage.getItem("k")', 'location.href="/x"']) {
      const r = await tool.execute('e1', { expression: expr });
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r.content)).toContain('禁用');
    }

    const big = makeFakePage({ evaluateResult: 'x'.repeat(40000) });
    const r2 = await createEvaluateTool({ page: big.page }).execute('e2', { expression: 'document.body.innerText' });
    expect(r2.isError).toBe(true);
    expect(JSON.stringify(r2.content)).toContain('返回值过大');
  }, 20000);

  it('C1 覆盖账本：路径去重 + 交互计数 + 回灌摘要', async () => {
    const { createCoverageTracker } = await import('../src/pi/exploration/coverage.js');
    const tracker = createCoverageTracker();
    const p1 = makeFakePage({ url: 'http://sut.example.com/app/assets?page=1' });
    const p2 = makeFakePage({ url: 'http://sut.example.com/app/assets?page=1' });
    const p3 = makeFakePage({ url: 'http://sut.example.com/' });

    tracker.recordUrl(p1.page);
    tracker.recordUrl(p2.page);
    tracker.recordUrl(p3.page); // root path is not recorded
    tracker.recordInteraction('click');
    tracker.recordInteraction('click');
    tracker.recordInteraction('fill');

    const snap = tracker.snapshot();
    expect(snap.paths).toEqual(['/app/assets?page=1']);
    expect(snap.interactions).toEqual([
      { kind: 'click', count: 2 },
      { kind: 'fill', count: 1 },
    ]);
    const rendered = tracker.render();
    expect(rendered).toContain('覆盖进度');
    expect(rendered).toContain('/app/assets?page=1');
    expect(rendered).toContain('click×2');
  }, 20000);

  it('coverageDigest：终态覆盖摘要——盖住多少 + 还差什么（未完成子目标点名）', async () => {
    const { coverageDigest } = await import('../src/pi/exploration/coverage.js');
    const snapshot = {
      paths: ['/app/assets', '/app/users'],
      interactions: [
        { kind: 'click', count: 3 },
        { kind: 'fill', count: 1 },
      ],
      goals: [
        { id: 'g1', text: '打开新增对话框', done: true },
        { id: 'g2', text: '空值提交看是否被拒', done: false },
        { id: 'g3', text: '越权访问他人资产', done: false },
      ],
      updatedAt: new Date().toISOString(),
    };

    const digest = coverageDigest(snapshot);
    expect(digest).toContain('页面 2 个');
    expect(digest).toContain('交互 4 次');
    expect(digest).toContain('子目标 1/3');
    expect(digest).toContain('g2 空值提交看是否被拒');
    // At most 3 unfinished items are named (beyond that only a count is given, no full listing — the digest is fed back with every observe round and burns tokens).
    const many = coverageDigest({ ...snapshot, goals: Array.from({ length: 6 }, (_, i) => ({ id: `g${i}`, text: `目标${i}`, done: false })) });
    expect(many).toContain('（另 3 条）');
    // With no subgoals, subgoals are not mentioned (a narrow charter should not be padded with filler).
    expect(coverageDigest({ ...snapshot, goals: [] })).not.toContain('子目标');
  }, 20000);

  it('D3 错误信号：console/HTTP 采集 + 增量 drain + 封顶 200', async () => {
    const { createErrorSignalCollector } = await import('../src/pi/exploration/observation.js');
    const handlers: Record<string, Array<(arg?: unknown) => void>> = {};
    const page = {
      on: (ev: string, fn: (arg?: unknown) => void) => {
        (handlers[ev] ??= []).push(fn);
      },
      off: () => undefined,
    } as unknown as Page;

    const collector = createErrorSignalCollector(page);
    handlers.console?.[0]?.({ type: () => 'error', text: () => 'Uncaught TypeError' });
    handlers.console?.[0]?.({ type: () => 'warning', text: () => '不该收' });
    handlers.response?.[0]?.({ status: () => 500, url: () => 'http://sut.example.com/api/boom' });

    const drained = collector.drainRendered();
    expect(drained.text).toContain('[console] Uncaught TypeError');
    expect(drained.text).toContain('[http] HTTP 500');
    expect(drained.count).toBe(2);
    // Incremental semantics: draining again after a drain yields empty (observe feedback carries only new signals, no repeat bombardment).
    expect(collector.drainRendered()).toEqual({ text: '', count: 0 });
    expect(collector.all()).toHaveLength(2);

    // Cap: new entries are dropped once past 200.
    for (let i = 0; i < 260; i += 1) handlers.console?.[0]?.({ type: () => 'error', text: () => `e${i}` });
    expect(collector.all().length).toBeLessThanOrEqual(200);
    collector.close();
  }, 20000);

  it('A1 证据帧：finding 落库带 evidence_frame、重复条目去重、落库成功后留痕片段清空', async () => {
    const sessionId = await insertSession();
    const fake = makeFakePage();
    let trail = [
      { type: 'navigate', target: 'http://sut.example.com/app', ok: true },
      { type: 'click', target: '#del', ok: true },
    ];
    const store = findingsMod.createFindingStore({
      sessionId,
      page: fake.page,
      getTrailSince: () => trail,
      resetTrailSince: () => {
        trail = [];
      },
      sessionStepsLength: () => 7,
      onPersist: async () => undefined,
    });

    const first = await store.report({ title: '删除后列表未刷新', description: '预期：删除后列表少一行；实际：仍显示旧数据', severity: 'P1' });
    expect(first.ok).toBe(true);
    expect(first.order).toBe(1);
    expect(store.savedCount).toBe(1);
    // After a successful persist, the trail segment "since the previous finding" is cleared.
    expect(trail).toHaveLength(0);

    const row = await pool.query(
      `SELECT title, severity, status, actions_trail, evidence_frame, screenshot_path FROM exploration_findings WHERE session_id=$1`,
      [sessionId],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]!.title).toBe('删除后列表未刷新');
    expect(row.rows[0]!.severity).toBe('P1');
    // Status stays pending before judge/human review (the platform does not change it).
    expect(row.rows[0]!.status).toBe('pending');
    const frame = row.rows[0]!.evidence_frame as { trailIndex: number; url: string };
    expect(frame.trailIndex).toBe(7);
    expect(frame.url).toContain('sut.example.com');
    const actionsTrail = row.rows[0]!.actions_trail as Array<{ type: string }>;
    expect(actionsTrail.map((t) => t.type)).toEqual(['navigate', 'click']);

    // Duplicate entry (near-synonym dedupe) → not persisted, savedCount unchanged.
    const dup = await store.report({ title: '删除后列表未刷新', description: '同一缺陷换个说法' });
    expect(dup.ok).toBe(false);
    expect(store.savedCount).toBe(1);

    // Missing title/description → rejected by shape tolerance.
    const bad = await store.report({});
    expect(bad.ok).toBe(false);
  }, 30000);

  it('trailStepOf：动作留痕形状对齐 legacy 词表（sql/repo/press/wait/fill 原值）', async () => {
    const { trailStepOf } = await import('../src/pi/exploration/tools/index.js');
    expect(trailStepOf('navigate', { url: 'http://x/a' })).toEqual({ type: 'navigate', target: 'http://x/a', ok: true });
    expect(trailStepOf('fill', { target: '#u', value: '__ITEST_USERNAME__' })).toEqual({
      type: 'fill',
      target: '#u',
      value: '__ITEST_USERNAME__',
      ok: true,
    });
    expect(trailStepOf('press', { key: 'Enter' })).toEqual({ type: 'press', target: 'Enter', key: 'Enter', ok: true });
    expect(trailStepOf('wait', { ms: 1500 })).toEqual({ type: 'wait', target: '1500', ms: 1500, ok: true });
    expect(trailStepOf('sql_probe', { query: 'SELECT  1\nFROM t' })).toEqual({
      type: 'sql',
      target: 'SELECT 1 FROM t',
      ok: true,
    });
    expect(trailStepOf('repo_read', { op: 'ls' })).toEqual({ type: 'repo', target: 'ls', ok: true });
    expect(trailStepOf('repo_read', { op: 'grep', pattern: 'useAuth' })).toEqual({
      type: 'repo',
      target: 'grep useAuth',
      ok: true,
    });
    expect(trailStepOf('click', { target: '#x' })).toEqual({ type: 'click', target: '#x', ok: true });
  }, 20000);
});
