/**
 * pi 探索工具层（P3）单测：闸门、沙箱、账本、证据帧落库。
 *
 * 覆盖：
 *  - click 破坏性闸（默认拒 / 显式授权放行）+ 脆弱 selector 闸；
 *  - fill 凭据占位符替换（留痕只记原值）+ 回读不一致反馈 + 缺凭据 → 终止性错误回调；
 *  - evaluate 三层沙箱的 L1（静态扫描拒收）与 L3（返回值封顶/序列化）闸；
 *  - C1 覆盖账本（路径去重/交互计数/回灌摘要）；
 *  - D3 错误信号（console/HTTP 采集、增量 drain、封顶）；
 *  - A1 证据帧：finding 落库带 evidence_frame、重复条目去重、落库成功后留痕片段清空；
 *  - trailStepOf 的动作留痕形状（legacy 词表对齐：sql/repo/press/wait…）。
 *
 * 工具用假 page 驱动（只提供工具真正调用的方法）；finding 落库走真 PG（列形状要真）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import type { Page } from 'playwright-core';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

/** 假 page：只提供工具真正调用的方法，并记录动作。 */
interface FakePageOpts {
  url?: string;
  /** locator().first().evaluate() 的返回值（click 取元素信息；fill 取下拉展开判定）。 */
  locatorEvaluateResult?: unknown;
  /** locator().first().inputValue() 的回读值。 */
  inputValue?: string;
  /** page.evaluate() 的返回值（evaluate 工具）。 */
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

/** 建一条会话行（findings 外键指向它）。 */
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

    // 回读值不同（且发生了替换）→ 反馈只给长度，绝不回显真实值。
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
    tracker.recordUrl(p3.page); // 根路径不记账
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
    expect(drained).toContain('[console] Uncaught TypeError');
    expect(drained).toContain('[http] HTTP 500');
    expect(collector.drainRendered()).toBe('');
    expect(collector.all()).toHaveLength(2);

    // 封顶：超过 200 条后丢弃新条目。
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
    // 落库成功后「自上一条 finding 起」的留痕片段清空。
    expect(trail).toHaveLength(0);

    const row = await pool.query(
      `SELECT title, severity, status, actions_trail, evidence_frame, screenshot_path FROM exploration_findings WHERE session_id=$1`,
      [sessionId],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]!.title).toBe('删除后列表未刷新');
    expect(row.rows[0]!.severity).toBe('P1');
    // judge/人工审阅前状态仍是 pending（平台不改）。
    expect(row.rows[0]!.status).toBe('pending');
    const frame = row.rows[0]!.evidence_frame as { trailIndex: number; url: string };
    expect(frame.trailIndex).toBe(7);
    expect(frame.url).toContain('sut.example.com');
    const actionsTrail = row.rows[0]!.actions_trail as Array<{ type: string }>;
    expect(actionsTrail.map((t) => t.type)).toEqual(['navigate', 'click']);

    // 重复条目（近义去重）→ 不落库，savedCount 不涨。
    const dup = await store.report({ title: '删除后列表未刷新', description: '同一缺陷换个说法' });
    expect(dup.ok).toBe(false);
    expect(store.savedCount).toBe(1);

    // 缺标题/描述 → 形状容错拒收。
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
