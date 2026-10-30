import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

// checkoutRepoForVersion 可注入桩;impl 为 undefined 时走真实实现(既有 no_repo 用例不受影响)
const mockCheckout = { impl: undefined as undefined | ((versionId: string) => Promise<string>) };

vi.mock('../src/pi/repo.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pi/repo.js')>();
  return {
    ...actual,
    checkoutRepoForVersion: (versionId: string) =>
      mockCheckout.impl ? mockCheckout.impl(versionId) : actual.checkoutRepoForVersion(versionId),
  };
});

// 跨副本运行闸门用:ioredis 换记账 fake(redisLock 的惰性连接)。其余测试不开 REDIS_URL,
// client() 直接走 null 分支,零影响;doMock 在 beforeAll 动态 import 之前注册,session.js
// 静态引入的 redisLock/threadBus 拿到的都是这份 fake。
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

let container: StartedPostgreSqlContainer;
let pool: Pool;

interface Captured { ctx: unknown; prompts: string[]; }
const captured: Captured[] = [];

/** 运行锁测试用:armed 时 prompt 挂起直到 need 个并发都进入——让两条消息在
 *  acquireRunSlot 视角真正重叠(假 prompt 微任务级完成时,后到的消息会在前者
 *  释放锁之后才拿锁,那是串行获取而非重入,测不出「重入只拿一次锁」)。 */
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
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
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
  await container.stop();
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
    // 项目未配 repoUrl → RepoUnavailableError('no_repo') 被吞,工厂收到 repo.noRepo=true 且 cwd/issue 未填
    // (后台检出尚未完成;不等其结束,保证会话秒开)
    expect(captured[0]!.ctx).toMatchObject({ threadId, versionId, projectId, repo: { cwd: null, issue: null } });

    await sendSpaceUserMessage(threadId, '帮我建三个登录用例');
    // 原文透传:服务端回显与前端乐观气泡逐字一致,react-pi 的 reconcile 才能去重
    expect(captured[0]!.prompts[0]).toBe('帮我建三个登录用例');
    const row = (await pool.query(`SELECT title FROM ai_threads WHERE id=$1`, [threadId])).rows[0] as { title: string | null };
    expect(row.title).toBe('帮我建三个登录用例');

    // 后续消息同样原文透传(上下文摘要改走 system prompt,不进消息流)
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
    // 方法论补 §6：页面控件以实测清单为准
    expect(REQ_DESIGN_METHOD).toContain('禁臆造控件');
    expect(REQ_DESIGN_METHOD).toContain('page.elements');
    // B 路径回报规则：简洁 + 只引用实测清单里真实存在的控件
    expect(CASE_AUTHORING_FLOW_ZH).toContain('回报要简洁');
    expect(CASE_AUTHORING_FLOW_EN).toContain('keep the report concise');
  });

  it('B 路径（边跑边讨论）文案：走 stage_case+verify_case，run_ai_step 已退役不再出现', async () => {
    const { CASE_AUTHORING_FLOW_ZH, CASE_AUTHORING_FLOW_EN } = await import('../src/pi/space/reqDesign.js');
    // B 入口段落存在且路由到 verify_case；分叉是「明确要求才进 B，纯需求输入走 A」
    expect(CASE_AUTHORING_FLOW_ZH).toContain('边跑边讨论');
    expect(CASE_AUTHORING_FLOW_ZH).toContain('verify_case');
    expect(CASE_AUTHORING_FLOW_ZH).not.toContain('run_ai_step');
    expect(CASE_AUTHORING_FLOW_EN).toContain('Run and discuss');
    expect(CASE_AUTHORING_FLOW_EN).toContain('verify_case');
    expect(CASE_AUTHORING_FLOW_EN).not.toContain('run_ai_step');
    // 10-27 prod228 实录（01a17cd5）：用户说了「打开页面」+给了深链,助手仍整段文字背页面结构、
    // 以「请告诉我第一条测试操作」收尾让用户点菜,首轮零 stage_case/verify_case。守卫 B 段
    // 必须带「拿到页面就开跑」的主动性规则,且被动等待框架措辞不得回归。
    expect(CASE_AUTHORING_FLOW_ZH).toContain('拿到页面就开跑');
    expect(CASE_AUTHORING_FLOW_ZH).toContain('观察步');
    expect(CASE_AUTHORING_FLOW_ZH).toContain('打开用户提供的测试页面');
    expect(CASE_AUTHORING_FLOW_ZH).toContain('请告诉我第一条测试操作'); // 作为被禁止的反模式出现
    expect(CASE_AUTHORING_FLOW_ZH).not.toContain('每收到一条操作指令');
    expect(CASE_AUTHORING_FLOW_EN).toContain('do not idle in text');
    expect(CASE_AUTHORING_FLOW_EN).toContain('open the test page the user provided');
    expect(CASE_AUTHORING_FLOW_EN).not.toContain('For each instruction:');
  });

  it('侦察红线文案：固化前禁 inspect_page/repo_*，失败先回报再动手（10-27 prod228 实录：失败分支自主考古 3 分钟）', async () => {
    const { CASE_AUTHORING_FLOW_ZH, CASE_AUTHORING_FLOW_EN, REQ_DESIGN_METHOD } = await import('../src/pi/space/reqDesign.js');
    // 红线块存在于中英文流程指引,且失败分支强调「先回报、后动手」
    expect(CASE_AUTHORING_FLOW_ZH).toContain('侦察红线');
    expect(CASE_AUTHORING_FLOW_ZH).toContain('禁止调用 inspect_page 与 repo_ls/repo_read/repo_grep/static_locator');
    expect(CASE_AUTHORING_FLOW_ZH).toContain('先回报失败详情与归因');
    expect(CASE_AUTHORING_FLOW_EN).toContain('Recon red line');
    expect(CASE_AUTHORING_FLOW_EN).toContain('report FIRST, then act');
    // REQ_DESIGN_METHOD:运行时机身证据优先取代「先抓页面」;§2 断言句不再点名 inspect_page
    expect(REQ_DESIGN_METHOD).toContain('运行时机身证据优先');
    expect(REQ_DESIGN_METHOD).not.toContain('断言前先触发对应操作:inspect_page');
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
    // 快照改为「seq 泵排空后异步补发」(水位≥内容,防双气泡),不再同步首达
    await vi.waitFor(() => expect(events[0]).toBeDefined());
    expect(events[0]!.type).toBe('snapshot');
    emitThreadEvent(threadId, { type: 'confirm_request', confirmId: 'c1' });
    // 事件经 seq 泵异步投递(Redis INCR 分配 seq;无 Redis 走本地兜底,仍是异步微任务)
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
    // pi 语义:用户消息同步进内容,message_start 紧随发射——fanOut 只入队,seq 戳在异步泵里盖
    await sendSpaceUserMessage(threadId, '只发一次');
    const userMsg = { role: 'user', content: '只发一次' };
    for (const l of fake.listeners) l({ type: 'message_start', message: userMsg });
    // 老实现此刻同步读 = 内容已含消息、水位仍旧值的毒快照;新实现等泵排空后再读
    const snap = await snapshotOfThread(threadId);
    const stampedSeq = delivered.filter((e) => e.type === 'message_start').at(-1)!.seq;
    expect(snap!.messages).toContainEqual(userMsg);
    expect(snap!.seq).toBe(stampedSeq); // 前端旧事件门按 seq>水位 放行,水位盖住即不会二次 append
    unsub();
  }, 30_000);

  it('毒快照回归:泵排队期订阅,快照须盖住已投递事件(水位≥内容,异步补发)', async () => {
    const { projectId, versionId } = await seedProject(pool);
    const threadId = await insertSpaceThread(versionId);
    const { ensureSpaceRecord, sendSpaceUserMessage, subscribeThread } = await import('../src/pi/space/session.js');
    const rec = await ensureSpaceRecord(threadId);
    const fake = rec.session as unknown as { listeners: Set<(e: unknown) => void> };
    // 真实场景:SSE 重连/新监听器恰好在发送后的泵窗口内进来——先有入队投递,再有订阅
    await sendSpaceUserMessage(threadId, 'hello');
    const userMsg = { role: 'user', content: 'hello' };
    for (const l of fake.listeners) l({ type: 'message_start', message: userMsg });
    const got: Record<string, unknown>[] = [];
    const unsub = subscribeThread(threadId, (e) => got.push(e as Record<string, unknown>), { includeSnapshot: true });
    // 微任务泵先送达盖戳的 message_start(监听器已同步注册),快照随后补发且水位不落后
    await vi.waitFor(() => expect(got.some((e) => e.type === 'snapshot')).toBe(true));
    const snapEv = got.find((e) => e.type === 'snapshot')!;
    const maxDelivered = Math.max(0, ...got.filter((e) => e.type !== 'snapshot').map((e) => Number(e.seq ?? 0)));
    expect((snapEv.snapshot as { messages: unknown[] }).messages).toContainEqual(userMsg);
    expect(Number(snapEv.seq)).toBeGreaterThanOrEqual(maxDelivered); // 迟到的 message_start 不会再穿门 append
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
      // 后台检出在 session 建立后异步跑;轮询直到 issue 落值(替代固定 sleep,在慢机上避免 flake)
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

      // 同副本并发(steer 语义,rcaWorker 二次 prompt 同款):barrier 让两个 prompt 同时挂起,
      // 第二条只能走 runs>0 重入,不重复拿锁
      armPromptBarrier(2);
      try {
        await Promise.all([sendSpaceUserMessage(threadId, '第一条'), sendSpaceUserMessage(threadId, '第二条')]);
      } finally {
        promptBarrier = null;
      }
      // seq 全局化后 buildSpaceRecord 先探 Redis 高水位,threadBus 先于 redisLock 建连;
      // FakeRedis.all 下标不再固定,按「收到过 set」定位 redisLock 那台。
      const redis = FakeRedis.all.find((r) => r.callsOf('set').length > 0)!;
      expect(redis.callsOf('set')).toHaveLength(1);
      expect(redis.callsOf('set')[0]).toEqual([`itest:thread-run:${threadId}`, expect.any(String), 'PX', 300_000, 'NX']);
      // 5s 心跳未到(毫秒级完成);runs 归零 → release 的 Lua DEL 恰一次
      expect(redis.callsOf('eval')).toHaveLength(1);
      expect(redis.callsOf('eval')[0]![2]).toBe(`itest:thread-run:${threadId}`);

      // 他副本持有(set → null)→ 抛错 + assistant_error 事件(messages 路由 204 先行,这是用户面)
      redis.results.set = null;
      await expect(sendSpaceUserMessage(threadId, '第三条')).rejects.toThrow('另一个实例');
      // assistant_error 经 seq 泵异步投递,等它落到订阅者
      await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: 'assistant_error' }));
      expect(String(events.at(-1)!.message)).toContain('另一个实例');
    } finally {
      delete process.env.REDIS_URL;
    }
  }, 30_000);
});
