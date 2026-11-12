import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

// checkoutRepoForVersion is injectable as a stub; when impl is undefined the real implementation runs (existing no_repo cases unaffected)
const mockCheckout = { impl: undefined as undefined | ((versionId: string) => Promise<string>) };

vi.mock('../src/pi/repo.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pi/repo.js')>();
  return {
    ...actual,
    checkoutRepoForVersion: (versionId: string) =>
      mockCheckout.impl ? mockCheckout.impl(versionId) : actual.checkoutRepoForVersion(versionId),
  };
});

// For the cross-replica run gate: ioredis is replaced with an accounting fake (redisLock's lazy connection).
// Other tests don't set REDIS_URL, so client() takes the null branch — zero impact; the doMock is registered
// before the dynamic import in beforeAll, so the redisLock/threadBus statically imported by session.js all get this fake.
class FakeRedis {
  static all: FakeRedis[] = [];
  static DEFAULTS: Record<string, unknown> = { set: 'OK', eval: 1 };
  calls: Record<string, unknown[][]> = {};
  results: Record<string, unknown> = {};
  constructor() { FakeRedis.all.push(this); }
  on(_e: string, _cb: (...a: never[]) => void) { return this; }
  private rec(cmd: string, args: unknown[]) {
    (this.calls[cmd] ??= []).push(args);
    const v = cmd in this.results ? this.results[cmd] : FakeRedis.DEFAULTS[cmd];
    if (v instanceof Error) return Promise.reject(v);
    return Promise.resolve(v);
  }
  set(...a: unknown[]) { return this.rec('set', a); }
  eval(...a: unknown[]) { return this.rec('eval', a); }
  publish(...a: unknown[]) { return this.rec('publish', a); }
  callsOf(cmd: string): unknown[][] { return this.calls[cmd] ?? []; }
}
vi.doMock('ioredis', () => ({ default: FakeRedis }));

let pool: Pool;

interface Captured { ctx: unknown; prompts: string[]; }
const captured: Captured[] = [];

/** For run-lock tests: while armed, prompt hangs until `need` concurrent callers have entered — so two messages
 *  genuinely overlap from acquireRunSlot's perspective (if the fake prompt completed at microtask level, the later
 *  message would take the lock only after the earlier one released it — serial acquisition, not re-entry,
 *  which can't prove "re-entry acquires the lock only once"). */
let promptBarrier: { need: number; n: number; open: () => void; p: Promise<void> } | null = null;

function armPromptBarrier(need: number): void {
  let open!: () => void;
  const p = new Promise<void>((r) => { open = r; });
  promptBarrier = { need, n: 0, open, p };
}

function makeFakeSession() {
  const listeners = new Set<(e: unknown) => void>();
  return {
    listeners,
    messages: [] as unknown[],
    prompts: [] as string[],
    subscribe(fn: (e: unknown) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
    async prompt(text: string) {
      this.prompts.push(text); this.messages.push({ role: 'user', content: text });
      const b = promptBarrier;
      if (b) { b.n += 1; if (b.n >= b.need) b.open(); await b.p; }
    },
    abort() {},
    async dispose() {},
    get isStreaming() { return false; },
  };
}

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  await import('../src/db/client.js');
  const { setSpaceSessionFactory } = await import('../src/pi/space/session.js');
  setSpaceSessionFactory(async (ctx) => {
    const s = makeFakeSession();
    captured.push({ ctx, prompts: s.prompts });
    return s as never;
  });
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
});

beforeEach(async () => {
  captured.length = 0;
  const { resetSpaceSessions } = await import('../src/pi/space/session.js');
  resetSpaceSessions();
  await pool.query(`TRUNCATE ai_threads RESTART IDENTITY CASCADE`);
});

async function insertSpaceThread(versionId: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(`INSERT INTO ai_threads(id, kind, version_id, pi_thread_id) VALUES ($1,'version',$2,'')`, [id, versionId]);
  return id;
}

describe('space session supervisor', () => {
  it('ensureSpaceRecord 绑定版本上下文;no_repo 静默降级;消息原文透传+落标题', async () => {
    const { projectId, versionId } = await seedProject(pool);
    const threadId = await insertSpaceThread(versionId);
    const { ensureSpaceRecord, sendSpaceUserMessage } = await import('../src/pi/space/session.js');

    const rec = await ensureSpaceRecord(threadId);
    expect(rec.versionId).toBe(versionId);
    // Project has no repoUrl → RepoUnavailableError('no_repo') is swallowed; the factory receives repo.noRepo=true with cwd/issue unfilled
    // (the background checkout hasn't finished; we don't wait for it, so the session opens instantly)
    expect(captured[0]!.ctx).toMatchObject({ threadId, versionId, projectId, repo: { cwd: null, issue: null } });

    await sendSpaceUserMessage(threadId, '帮我建三个登录用例');
    // Verbatim passthrough: the server echo matches the frontend's optimistic bubble word for word, so react-pi's reconcile can dedupe
    expect(captured[0]!.prompts[0]).toBe('帮我建三个登录用例');
    const row = (await pool.query(`SELECT title FROM ai_threads WHERE id=$1`, [threadId])).rows[0] as { title: string | null };
    expect(row.title).toBe('帮我建三个登录用例');

    // Follow-up messages are also passed through verbatim (the context summary goes into the system prompt, not the message stream)
    await sendSpaceUserMessage(threadId, '再建一个');
    expect(captured[0]!.prompts[1]).toBe('再建一个');
  }, 30_000);

  it('buildSpaceSystemPrompt:始终含风格段与需求设计方法;有摘要追加版本空间上下文标题', async () => {
    const { buildSpaceSystemPrompt } = await import('../src/pi/space/session.js');
    const { REQ_DESIGN_METHOD, CASE_AUTHORING_FLOW_ZH } = await import('../src/pi/space/reqDesign.js');
    const guides = [
      { kind: 'flow' as const, body: REQ_DESIGN_METHOD },
      { kind: 'flow' as const, body: CASE_AUTHORING_FLOW_ZH },
    ];
    const base = buildSpaceSystemPrompt(null, undefined, guides);
    expect(base).toContain('输出风格');
    expect(base).toContain('需求→用例设计方法');
    expect(base).toContain('流程指令');
    const out = buildSpaceSystemPrompt('X', undefined, guides);
    expect(out).toContain('X');
    expect(out).toContain('版本空间上下文');
  });

  it('用例创建流程文案（ZH/EN）含 mechanical 验收与轨迹复用（agent 依此选路）', async () => {
    const { CASE_AUTHORING_FLOW_ZH, CASE_AUTHORING_FLOW_EN } = await import('../src/pi/space/reqDesign.js');
    expect(CASE_AUTHORING_FLOW_ZH).toContain('mechanical');
    expect(CASE_AUTHORING_FLOW_ZH).toContain('轨迹');
    expect(CASE_AUTHORING_FLOW_ZH).toContain('零执行');
    expect(CASE_AUTHORING_FLOW_EN).toContain('mechanical');
    expect(CASE_AUTHORING_FLOW_EN).toContain('ZERO execution');
  });

  it('简洁专业+禁臆造文案（10-28 prod228 实录：回复啰嗦、编造「时间范围」筛选项）', async () => {
    const { buildSpaceSystemPrompt } = await import('../src/pi/space/session.js');
    const { REQ_DESIGN_METHOD, CASE_AUTHORING_FLOW_ZH, CASE_AUTHORING_FLOW_EN } = await import('../src/pi/space/reqDesign.js');
    const zh = buildSpaceSystemPrompt(null, undefined, []);
    expect(zh).toContain('结论先行');
    expect(zh).toContain('杜绝胡编乱造');
    const en = buildSpaceSystemPrompt(null, 'en-US', []);
    expect(en).toContain('Never fabricate');
    // Methodology §6 addition: page controls are governed by the measured element list
    expect(REQ_DESIGN_METHOD).toContain('禁臆造控件');
    expect(REQ_DESIGN_METHOD).toContain('page.elements');
    // Path B reporting rule: concise + only reference controls that actually exist in the measured list
    expect(CASE_AUTHORING_FLOW_ZH).toContain('回报要简洁');
    expect(CASE_AUTHORING_FLOW_EN).toContain('keep the report concise');
  });

  it('B 路径（边跑边讨论）文案：走 stage_case+verify_case，run_ai_step 已退役不再出现', async () => {
    const { CASE_AUTHORING_FLOW_ZH, CASE_AUTHORING_FLOW_EN } = await import('../src/pi/space/reqDesign.js');
    // The Path B entry section exists and routes to verify_case; the fork is "enter B only when explicitly asked, pure requirement input goes A"
    expect(CASE_AUTHORING_FLOW_ZH).toContain('边跑边讨论');
    expect(CASE_AUTHORING_FLOW_ZH).toContain('verify_case');
    expect(CASE_AUTHORING_FLOW_ZH).not.toContain('run_ai_step');
    expect(CASE_AUTHORING_FLOW_EN).toContain('Run and discuss');
    expect(CASE_AUTHORING_FLOW_EN).toContain('verify_case');
    expect(CASE_AUTHORING_FLOW_EN).not.toContain('run_ai_step');
    // 10-27 prod228 incident (01a17cd5): the user said "open the page" + gave a deep link, yet the assistant recited the page structure in
    // a wall of text and ended with "please tell me the first test operation", leaving zero stage_case/verify_case in round one. Guard B's
    // section must carry the proactive "start running once you have the page" rule, and the passive wait-for-instructions wording must not regress.
    expect(CASE_AUTHORING_FLOW_ZH).toContain('拿到页面就开跑');
    expect(CASE_AUTHORING_FLOW_ZH).toContain('观察步');
    expect(CASE_AUTHORING_FLOW_ZH).toContain('打开用户提供的测试页面');
    expect(CASE_AUTHORING_FLOW_ZH).toContain('请告诉我第一条测试操作'); // appears as a forbidden anti-pattern
    expect(CASE_AUTHORING_FLOW_ZH).not.toContain('每收到一条操作指令');
    expect(CASE_AUTHORING_FLOW_EN).toContain('do not idle in text');
    expect(CASE_AUTHORING_FLOW_EN).toContain('open the test page the user provided');
    expect(CASE_AUTHORING_FLOW_EN).not.toContain('For each instruction:');
  });

  it('证据自取纪律文案：事实自己取证、实测为最终证据、失败先回报再深挖（11-07 用户口径：动不动求助用户=不智能）', async () => {
    const { CASE_AUTHORING_FLOW_ZH, CASE_AUTHORING_FLOW_EN, REQ_DESIGN_METHOD } = await import('../src/pi/space/reqDesign.js');
    // The discipline block exists in both the ZH and EN flow guides: self-serve channel enumeration + measured evidence as final say + asking the user limited to two cases
    expect(CASE_AUTHORING_FLOW_ZH).toContain('证据自取纪律');
    expect(CASE_AUTHORING_FLOW_ZH).toContain('repo_ls/repo_read/repo_grep(读代码)');
    expect(CASE_AUTHORING_FLOW_ZH).toContain('求助用户只限两类');
    expect(CASE_AUTHORING_FLOW_ZH).toContain('先回报再深挖');
    expect(CASE_AUTHORING_FLOW_EN).toContain('Self-serve evidence discipline');
    expect(CASE_AUTHORING_FLOW_EN).toContain('report FIRST, then dig');
    expect(CASE_AUTHORING_FLOW_EN).toContain('ask the user ONLY for two things');
    // The old "no recon without consent" red line must not regress
    expect(CASE_AUTHORING_FLOW_ZH).not.toContain('未经用户同意,禁止调用 inspect_page');
    expect(CASE_AUTHORING_FLOW_EN).not.toContain('Recon red line');
    // REQ_DESIGN_METHOD: runtime on-device evidence first + §6 self-serve evidence (the old three-path / bare question-throwing wording must not regress)
    expect(REQ_DESIGN_METHOD).toContain('运行时机身证据优先');
    expect(REQ_DESIGN_METHOD).toContain('缺页面事实自己取证,不抛给用户');
    expect(REQ_DESIGN_METHOD).toContain('求助用户只限两类');
    expect(REQ_DESIGN_METHOD).not.toContain('给用户确认路径而不是裸抛问题');
    expect(REQ_DESIGN_METHOD).not.toContain('断言前先触发对应操作:inspect_page');
  });

  it('DB/API 步例外措辞：guide 0001/0002/0003 都放行 sql/httpRequest 带 compiled（原禁令仍在但已被限定）', async () => {
    const { CASE_AUTHORING_FLOW_ZH, CASE_AUTHORING_FLOW_EN, REQ_DESIGN_METHOD } = await import('../src/pi/space/reqDesign.js');

    // 0001 REQ_DESIGN_METHOD: use httpRequest / sql when server-side truth is needed, and make explicit that they must carry compiled
    expect(REQ_DESIGN_METHOD).toContain('httpRequest/sql 这类步骤不经浏览器执行');
    expect(REQ_DESIGN_METHOD).toContain('必须带上 compiled');
    expect(REQ_DESIGN_METHOD).toContain('要直接查库就用 sql 步骤');
    // queryDb has been retired: guides must no longer mention it
    expect(REQ_DESIGN_METHOD).not.toContain('queryDb');

    // 0002 Chinese: the original step-3 ban is kept, but immediately followed by the DB/API exception (exception after the ban = the ban is scoped, not deleted)
    const zhBan = CASE_AUTHORING_FLOW_ZH.indexOf('不要急着生成 compiled');
    const zhExc = CASE_AUTHORING_FLOW_ZH.indexOf('唯一例外：查库/调接口的步骤——sql / httpRequest——在这一步就带上 compiled');
    expect(zhBan).toBeGreaterThanOrEqual(0);
    expect(zhExc).toBeGreaterThan(zhBan);
    expect(zhExc - zhBan).toBeLessThan(600); // the exception follows right after the ban, not a separate sentence scattered elsewhere
    // Entry B (staging = real measurement) is allowed through the same way: any new instruction that is a DB lookup / API call carries compiled
    expect(CASE_AUTHORING_FLOW_ZH).toContain('本条若是查库/调接口的步骤,则带 compiled');

    // 0003 English mirror
    const enBan = CASE_AUTHORING_FLOW_EN.indexOf('do NOT generate compiled mechanical DSL yet');
    const enExc = CASE_AUTHORING_FLOW_EN.indexOf('exception: a database-lookup or API-call step — sql / httpRequest — MUST carry its compiled array at this stage');
    expect(enBan).toBeGreaterThanOrEqual(0);
    expect(enExc).toBeGreaterThan(enBan);
    expect(enExc - enBan).toBeLessThan(600);
    expect(CASE_AUTHORING_FLOW_EN).toContain('except a database/API step, which must carry its compiled array');
  });

  it('取证渠道只提真实注册的工具：不得出现不存在的 dbQuery', async () => {
    const { CASE_AUTHORING_FLOW_ZH, CASE_AUTHORING_FLOW_EN, REQ_DESIGN_METHOD } = await import('../src/pi/space/reqDesign.js');
    const { STYLE_ZH_DEFAULT, STYLE_EN_DEFAULT } = await import('../src/pi/space/promptModules.js');
    // dbQuery was never a registered tool (the registered names are query_stats / manage_environments / manage_datasets).
    // Putting it in the "evidence channel" list would make the AI call a nonexistent tool — only real tool names may remain.
    for (const text of [REQ_DESIGN_METHOD, CASE_AUTHORING_FLOW_ZH, CASE_AUTHORING_FLOW_EN, STYLE_ZH_DEFAULT, STYLE_EN_DEFAULT]) {
      expect(text).not.toContain('dbQuery');
    }
    expect(REQ_DESIGN_METHOD).toContain('manage_environments/manage_datasets');
    expect(CASE_AUTHORING_FLOW_ZH).toContain('manage_environments/manage_datasets(配置与数据)');
    expect(CASE_AUTHORING_FLOW_EN).toContain('manage_environments/manage_datasets (config & data)');
  });

  it('登录类用例干净会话文案：guide 0002/0003 标明 verify 自动干净会话起跑（11-08 prod228 登录用例 3 轮全灭修复）', async () => {
    const { CASE_AUTHORING_FLOW_ZH, CASE_AUTHORING_FLOW_EN } = await import('../src/pi/space/reqDesign.js');
    expect(CASE_AUTHORING_FLOW_ZH).toContain('例外:测登录本身的用例');
    expect(CASE_AUTHORING_FLOW_ZH).toContain('干净会话');
    expect(CASE_AUTHORING_FLOW_EN).toContain('cases that test login itself');
    expect(CASE_AUTHORING_FLOW_EN).toContain('clean session');
  });

  it('buildSpaceSystemPrompt(…,en-US):英文风格段,不含简体中文约束', async () => {
    const { buildSpaceSystemPrompt } = await import('../src/pi/space/session.js');
    const en = buildSpaceSystemPrompt(null, 'en-US');
    expect(en).toContain('Output style');
    expect(en).not.toContain('简体中文');
    const enSummary = buildSpaceSystemPrompt('X', 'en-US');
    expect(enSummary).toContain('版本空间上下文');
  });

  it('requirement 线程不能走空间 supervisor', async () => {
    const { projectId } = await seedProject(pool);
    const req = (await pool.query(`INSERT INTO requirements(project_id, title, content) VALUES ($1,'r','c') RETURNING id`, [projectId])).rows[0]!.id as string;
    const id = crypto.randomUUID();
    await pool.query(`INSERT INTO ai_threads(id, kind, requirement_id, pi_thread_id) VALUES ($1,'requirement',$2,'')`, [id, req]);
    const { ensureSpaceRecord } = await import('../src/pi/space/session.js');
    await expect(ensureSpaceRecord(id)).rejects.toThrow();
  }, 30_000);

  it('emitThreadEvent 向订阅者广播并带 threadId+seq', async () => {
    const { versionId } = await seedProject(pool);
    const threadId = await insertSpaceThread(versionId);
    const { ensureSpaceRecord, emitThreadEvent, subscribeThread } = await import('../src/pi/space/session.js');
    await ensureSpaceRecord(threadId);
    const events: Record<string, unknown>[] = [];
    const unsub = subscribeThread(threadId, (e) => events.push(e as Record<string, unknown>), { includeSnapshot: true });
    // The snapshot changed to "async catch-up after the seq pump drains" (watermark ≥ content, prevents double bubbles); no longer synchronous first delivery
    await vi.waitFor(() => expect(events[0]).toBeDefined());
    expect(events[0]!.type).toBe('snapshot');
    emitThreadEvent(threadId, { type: 'confirm_request', confirmId: 'c1' });
    // Events are delivered asynchronously via the seq pump (Redis INCR assigns seq; without Redis a local fallback runs, still an async microtask)
    await vi.waitFor(() => expect(events[1]).toBeDefined());
    expect(events[1]).toMatchObject({ type: 'confirm_request', confirmId: 'c1', threadId });
    expect(typeof events[1]!.seq).toBe('number');
    unsub();
  }, 30_000);

  it('毒快照回归:泵未盖戳时取快照须等投递完成,水位盖住 message_start(只输一次回显两次的根因)', async () => {
    const { projectId, versionId } = await seedProject(pool);
    const threadId = await insertSpaceThread(versionId);
    const { ensureSpaceRecord, sendSpaceUserMessage, snapshotOfThread, subscribeThread } = await import('../src/pi/space/session.js');
    const rec = await ensureSpaceRecord(threadId);
    const fake = rec.session as unknown as { listeners: Set<(e: unknown) => void> };
    const delivered: Record<string, unknown>[] = [];
    const unsub = subscribeThread(threadId, (e) => delivered.push(e as Record<string, unknown>));
    // pi semantics: the user message enters content synchronously and message_start fires right after — fanOut only enqueues; the seq stamp is applied in the async pump
    await sendSpaceUserMessage(threadId, '只发一次');
    const userMsg = { role: 'user', content: '只发一次' };
    for (const l of fake.listeners) l({ type: 'message_start', message: userMsg });
    // The old implementation reads synchronously here = a poisoned snapshot where content already includes the message but the watermark is stale; the new implementation reads after the pump drains
    const snap = await snapshotOfThread(threadId);
    const stampedSeq = delivered.filter((e) => e.type === 'message_start').at(-1)!.seq;
    expect(snap!.messages).toContainEqual(userMsg);
    expect(snap!.seq).toBe(stampedSeq); // the frontend's old-event gate admits seq > watermark; with the watermark covering it there's no second append
    unsub();
  }, 30_000);

  it('毒快照回归:泵排队期订阅,快照须盖住已投递事件(水位≥内容,异步补发)', async () => {
    const { projectId, versionId } = await seedProject(pool);
    const threadId = await insertSpaceThread(versionId);
    const { ensureSpaceRecord, sendSpaceUserMessage, subscribeThread } = await import('../src/pi/space/session.js');
    const rec = await ensureSpaceRecord(threadId);
    const fake = rec.session as unknown as { listeners: Set<(e: unknown) => void> };
    // Real scenario: an SSE reconnect / new listener arrives exactly inside the post-send pump window — enqueue-delivery first, subscription second
    await sendSpaceUserMessage(threadId, 'hello');
    const userMsg = { role: 'user', content: 'hello' };
    for (const l of fake.listeners) l({ type: 'message_start', message: userMsg });
    const got: Record<string, unknown>[] = [];
    const unsub = subscribeThread(threadId, (e) => got.push(e as Record<string, unknown>), { includeSnapshot: true });
    // The microtask pump first delivers the stamped message_start (the listener was registered synchronously), then the snapshot catch-up follows with a watermark that doesn't lag
    await vi.waitFor(() => expect(got.some((e) => e.type === 'snapshot')).toBe(true));
    const snapEv = got.find((e) => e.type === 'snapshot')!;
    const maxDelivered = Math.max(0, ...got.filter((e) => e.type !== 'snapshot').map((e) => Number(e.seq ?? 0)));
    expect((snapEv.snapshot as { messages: unknown[] }).messages).toContainEqual(userMsg);
    expect(Number(snapEv.seq)).toBeGreaterThanOrEqual(maxDelivered); // the late message_start can't pass the gate into a second append
    unsub();
  }, 30_000);

  it('并发 ensureSpaceRecord 单飞:工厂只调一次,双方拿到同一 record', async () => {
    const { projectId, versionId } = await seedProject(pool);
    const threadId = await insertSpaceThread(versionId);
    const { ensureSpaceRecord } = await import('../src/pi/space/session.js');
    const [a, b] = await Promise.all([ensureSpaceRecord(threadId), ensureSpaceRecord(threadId)]);
    expect(a).toBe(b);
    expect(captured).toHaveLength(1);
  }, 30_000);

  it('checkout 失败(非 no_repo):session 照常建立,后台检出失败后 repo.issue 落值', async () => {
    const { versionId } = await seedProject(pool);
    const threadId = await insertSpaceThread(versionId);
    const { ensureSpaceRecord, spaceRepoIssue } = await import('../src/pi/space/session.js');
    const { RepoUnavailableError } = await import('../src/pi/repo.js');
    mockCheckout.impl = async () => { throw new RepoUnavailableError('auth_failed', 'PAT 无效'); };
    try {
      const rec = await ensureSpaceRecord(threadId);
      expect(rec.versionId).toBe(versionId);
      // The background checkout runs asynchronously after session creation; poll until issue gets its value (instead of a fixed sleep, avoids flake on slow machines)
      let issue: string | null = null;
      for (let i = 0; i < 30; i++) {
        issue = spaceRepoIssue(threadId);
        if (issue) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(issue).toContain('auth_failed');
    } finally {
      mockCheckout.impl = undefined;
    }
  }, 30_000);

  it('跨副本运行闸门:同副本 steer 重入只拿一次锁;他副本持有 → assistant_error + 抛错', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    try {
      const { projectId, versionId } = await seedProject(pool);
      const threadId = await insertSpaceThread(versionId);
      const { ensureSpaceRecord, sendSpaceUserMessage, subscribeThread } = await import('../src/pi/space/session.js');
      await ensureSpaceRecord(threadId);
      const events: Record<string, unknown>[] = [];
      subscribeThread(threadId, (e) => events.push(e as Record<string, unknown>));

      // Same-replica concurrency (steer semantics, same as rcaWorker's second prompt): the barrier suspends both prompts,
      // so the second can only take the runs>0 re-entry path and never grabs the lock twice
      armPromptBarrier(2);
      try {
        await Promise.all([sendSpaceUserMessage(threadId, '第一条'), sendSpaceUserMessage(threadId, '第二条')]);
      } finally {
        promptBarrier = null;
      }
      // After seq went global, buildSpaceRecord probes the Redis watermark first, and threadBus connects before redisLock;
      // FakeRedis.all's index is no longer fixed — locate the redisLock instance by "has received a set".
      const redis = FakeRedis.all.find((r) => r.callsOf('set').length > 0)!;
      expect(redis.callsOf('set')).toHaveLength(1);
      expect(redis.callsOf('set')[0]).toEqual([`itest:thread-run:${threadId}`, expect.any(String), 'PX', 300_000, 'NX']);
      // The 5s heartbeat never fires (finished in milliseconds); runs drops to zero → release's Lua DEL runs exactly once
      expect(redis.callsOf('eval')).toHaveLength(1);
      expect(redis.callsOf('eval')[0]![2]).toBe(`itest:thread-run:${threadId}`);

      // Another replica holds it (set → null) → throw + assistant_error event (the messages route's 204 comes first; that's the user-facing side)
      redis.results.set = null;
      await expect(sendSpaceUserMessage(threadId, '第三条')).rejects.toThrow('另一个实例');
      // assistant_error is delivered asynchronously via the seq pump; wait for it to reach the subscriber
      await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: 'assistant_error' }));
      expect(String(events.at(-1)!.message)).toContain('另一个实例');
    } finally {
      delete process.env.REDIS_URL;
    }
  }, 30_000);
});
