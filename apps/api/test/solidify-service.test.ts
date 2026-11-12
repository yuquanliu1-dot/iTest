/** Solidification inventory pipeline: re-entry guard / LLM unconfigured / empty input / distill-to-DB / per-item drop / timeout / no landing key; R3.6 session signal wiring. */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_SQL, seedLlmChannel, seedProject } from './helpers/db.js';

// Only reached by the "internally constructed client" cases (all other cases get a DI-injected stub and never touch the real SDK).
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    messages = { create: createMock };
  }
  return { __esModule: true, default: Anthropic };
});

let pool: Pool;
let sessionsRoot: string;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  sessionsRoot = await mkdtemp(join(tmpdir(), 'pi-sess-ss-'));
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
});

beforeEach(async () => {
  // RESTART IDENTITY: R3.5 cases hardcode rollback#2 / refId '2', so bigserial must restart from 1 for every case.
  await pool.query(`TRUNCATE assistant_solidify_proposals, assistant_solidify_batches, assistant_memories, assistant_trajectories, assistant_skills, assistant_failure_signals, assistant_failure_lessons, assistant_prompt_module_versions, settings, ai_threads RESTART IDENTITY`);
});

/** stub LLM client: completeJson passes value/model straight through on the first call with kind:'json' (same style as trajectory-worker.test). */
function stubClient(value: unknown) {
  return {
    provider: 'openai' as const,
    complete: async () => ({ kind: 'json' as const, value, provider: 'openai' as const, vision: false, model: 'stub-model' }),
  };
}

/** Sequential-counting stub: call#1 = lesson distillation, call#2 = asset distillation, replayed in order; records inputs (asserted via JSON.stringify).
 *  Function values support async (the lesson row is only inserted during call#1 processing, so the call#2 callback must query the DB for the lesson id). */
function sequentialStub(values: Array<unknown | ((prevReq: unknown) => unknown)>) {
  let i = 0;
  const calls: unknown[] = [];
  return {
    provider: 'openai' as const,
    calls,
    complete: async (req: unknown) => {
      calls.push(req);
      const raw = values[Math.min(i, values.length - 1)];
      const v = typeof raw === 'function' ? await (raw as (r: unknown) => unknown)(calls[calls.length - 2] ?? req) : raw;
      i += 1;
      return { kind: 'json' as const, value: v, provider: 'openai' as const, vision: false, model: 'stub-model' };
    },
  };
}

/** Seed one round of the "manual rollback + restore default" version chain (S1 signal source): seq 2 = rollback, seq 4 = restore_default. */
async function seedRollbackSignal(): Promise<void> {
  await pool.query(
    `INSERT INTO assistant_prompt_module_versions (module_key, value, source) VALUES
     ('space.style.zh', '断言未限定实测范围的旧表述', 'baseline'),
     ('space.style.zh', '修正后的断言表述', 'rollback'),
     ('tool.verify_case.guidelines', '旧指引', 'baseline'),
     ('tool.verify_case.guidelines', NULL, 'manual_edit')`);
}

async function seedSources(): Promise<{ memoryId: string; trajectoryId: string; lineId: string }> {
  const { projectId, productLineId: lineId } = await seedProject(pool);
  void projectId;
  const memoryId = randomUUID();
  const trajectoryId = randomUUID();
  await pool.query(
    `INSERT INTO assistant_memories (id, scope, product_line_id, title, hook, body, provenance, hit_count)
     VALUES ($1, 'product_line', $2, '断言写法', '断言前先实测', 'verify_case 实测后再断言，元素清单没有的控件当不存在', 'ai_inferred', 3)`,
    [memoryId, lineId]);
  await pool.query(
    `INSERT INTO assistant_trajectories (id, product_line_id, task_title, task_keywords, digest, case_title, distill_model, hit_count)
     VALUES ($1, $2, '列表页筛选任务', '列表 筛选', '## 任务描述\n…', '筛选导出', 'm', 2)`,
    [trajectoryId, lineId]);
  return { memoryId, trajectoryId, lineId };
}

async function newBatchId(): Promise<string> {
  return (await pool.query(`INSERT INTO assistant_solidify_batches (status) VALUES ('running') RETURNING id`)).rows[0]!.id as string;
}

async function batchRow(id: string) {
  return (await pool.query(`SELECT * FROM assistant_solidify_batches WHERE id=$1`, [id])).rows[0]!;
}

describe('startSolidifyScan：防重入', () => {
  it('已有 running 批次 → 409', async () => {
    const { startSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    await newBatchId();
    await expect(startSolidifyScan(null)).rejects.toMatchObject({ status: 409 });
  });
});

describe('runSolidifyScan', () => {
  it('LLM 未配置 → 批次 failed + error 说明', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    const id = await newBatchId();
    await runSolidifyScan(id); // test DB settings empty → readLlmConfig null
    const b = await batchRow(id);
    expect(b.status).toBe('failed');
    expect(b.error).toContain('LLM 未配置');
  });

  it('空输入（无记忆无轨迹）→ done + 0/0/0，不调 LLM', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    const id = await newBatchId();
    await runSolidifyScan(id, { client: stubClient({ proposals: [], notes: [] }) });
    const b = await batchRow(id);
    expect(b.status).toBe('done');
    const summary = JSON.parse(b.input_summary as string);
    expect(summary).toMatchObject({ memories: 0, trajectories: 0, proposals: 0 });
  });

  it('prompt_amendment 入库：retireRecommended 服务端定值（memory=true）', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    const { memoryId } = await seedSources();
    const id = await newBatchId();
    await runSolidifyScan(id, { client: stubClient({
      proposals: [{ kind: 'prompt_amendment', target: 'space.style.zh', title: '断言证据约束', body: '- 断言必须有实测证据', rationale: '2 条来源线支撑', sources: [memoryId] }],
      notes: [],
    }) });
    const b = await batchRow(id);
    expect(b.status).toBe('done');
    const p = (await pool.query(`SELECT * FROM assistant_solidify_proposals`)).rows[0]!;
    expect(p.kind).toBe('prompt_amendment');
    expect(p.target).toBe('space.style.zh');
    expect(p.status).toBe('pending');
    expect(p.distill_model).toBe('stub-model');
    expect(p.sources[0]).toMatchObject({ type: 'memory', id: memoryId, retireRecommended: true });
  });

  it('trajectory source → retireRecommended=false', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    const { trajectoryId } = await seedSources();
    const id = await newBatchId();
    await runSolidifyScan(id, { client: stubClient({
      proposals: [{ kind: 'prompt_amendment', target: 'space.workspace', title: 't', body: 'b', rationale: 'r', sources: [trajectoryId] }],
      notes: [],
    }) });
    const p = (await pool.query(`SELECT * FROM assistant_solidify_proposals`)).rows[0]!;
    expect(p.sources[0]).toMatchObject({ type: 'trajectory', id: trajectoryId, retireRecommended: false });
  });

  it('target 无落点 → 丢弃该条 + 记 note；有效条保留', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    const { memoryId } = await seedSources();
    const id = await newBatchId();
    await runSolidifyScan(id, { client: stubClient({
      proposals: [
        { kind: 'prompt_amendment', target: 'no.such.key', title: '坏', body: 'b', rationale: 'r', sources: [memoryId] },
        { kind: 'prompt_amendment', target: 'space.style.zh', title: '好', body: 'b', rationale: 'r', sources: [memoryId] },
      ],
      notes: [],
    }) });
    const b = await batchRow(id);
    expect(b.status).toBe('done');
    const rows = (await pool.query(`SELECT title FROM assistant_solidify_proposals`)).rows;
    expect(rows.map((r) => r.title)).toEqual(['好']);
    const summary = JSON.parse(b.input_summary as string);
    expect(summary.notes.some((n: string) => n.includes('无落点'))).toBe(true);
  });

  it('skill_revision：target 须在现有 skill 清单', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    const { memoryId } = await seedSources();
    await pool.query(`INSERT INTO assistant_skills (name, description) VALUES ('demo-skill', 'd')`);
    const id = await newBatchId();
    await runSolidifyScan(id, { client: stubClient({
      proposals: [
        { kind: 'skill_revision', target: 'demo-skill', title: '改skill', body: '新正文', rationale: 'r', sources: [memoryId] },
        { kind: 'skill_revision', target: 'ghost-skill', title: '幽灵', body: 'b', rationale: 'r', sources: [memoryId] },
      ],
      notes: ['建议人工用 skill-creator 新建：无落点的泛化经验'],
    }) });
    const rows = (await pool.query(`SELECT target FROM assistant_solidify_proposals`)).rows;
    expect(rows.map((r) => r.target)).toEqual(['demo-skill']);
    const b = await batchRow(id);
    const summary = JSON.parse(b.input_summary as string);
    expect(summary.notes.some((n: string) => n.includes('skill-creator'))).toBe(true);
  });

  it('单条提案形状不合法 → 丢弃该条不炸批次（整体仍 done）', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    const { memoryId } = await seedSources();
    const id = await newBatchId();
    await runSolidifyScan(id, { client: stubClient({
      proposals: [
        { kind: 'prompt_amendment', target: 'space.style.zh', title: '好', body: 'b', rationale: 'r', sources: [memoryId] },
        { kind: 'prompt_amendment', target: 'space.style.zh', /* body missing */ title: '坏', rationale: 'r', sources: [memoryId] },
      ],
      notes: [],
    }) });
    const b = await batchRow(id);
    expect(b.status).toBe('done'); // not failed
    const n = (await pool.query(`SELECT count(*)::int n FROM assistant_solidify_proposals`)).rows[0]!;
    expect(n.n).toBe(1);
  });

  it('LLM 输出整体形状不合法 → 批次 failed', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    await seedSources();
    const id = await newBatchId();
    await runSolidifyScan(id, { client: stubClient({ proposals: '不是数组' }) });
    const b = await batchRow(id);
    expect(b.status).toBe('failed');
  });

  it('LLM 超时 → 批次 failed + error 带 timeout', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    await seedSources();
    const id = await newBatchId();
    const hang = { provider: 'openai' as const, complete: () => new Promise<never>(() => {}), vision: false, model: 'stub' };
    await runSolidifyScan(id, { client: hang as never, llmTimeoutMs: 50 });
    const b = await batchRow(id);
    expect(b.status).toBe('failed');
    expect(b.error).toContain('timeout');
  });
});

describe('runSolidifyScan：R3.5 失败教训', () => {
  it('红线：零信号 → call#1 不发生（LLM 只调 1 次）且入参不含【失败教训】', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    const { memoryId } = await seedSources();
    void memoryId;
    const stub = sequentialStub([{ proposals: [], notes: [] }]);
    const id = await newBatchId();
    await runSolidifyScan(id, { client: stub as never });
    expect(stub.calls).toHaveLength(1);
    // The system prompt itself contains the "【失败教训】" directive copy; the red line anchors on the input section marker — with zero signals
    // the 【失败教训】 section (section header + [L1] entries) must not appear.
    expect(JSON.stringify(stub.calls[0])).not.toContain('（prompt_correction 的证据来源');
    expect(JSON.stringify(stub.calls[0])).not.toContain('[L1]');
    const b = await batchRow(id);
    const summary = JSON.parse(b.input_summary as string);
    expect(summary).toMatchObject({ memories: 1, lessons: 0, signals: 0 });
  });

  it('有信号但资产池为空 → 不早退，照跑（教训可独立产提案）', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    await seedRollbackSignal();
    const stub = sequentialStub([
      { lessons: [], notes: [] },
      { proposals: [], notes: [] },
    ]);
    const id = await newBatchId();
    await runSolidifyScan(id, { client: stub as never });
    expect(stub.calls).toHaveLength(2);
    expect((await batchRow(id)).status).toBe('done');
  });

  it('prompt_correction 链路：教训入库→进 call#2 输入→提案带 baseSeq+lesson sources', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    await seedRollbackSignal();
    const stub = sequentialStub([
      { lessons: [{ attribution: 'prompt', title: '断言表述未限定实测范围', lesson: '现象:…根因:…影响面:…建议:限定实测范围', signalRefs: ['rollback#2'] }], notes: [] },
      async () => {
        const lid = (await pool.query(`SELECT id FROM assistant_failure_lessons LIMIT 1`)).rows[0]!.id as string;
        return { proposals: [{ kind: 'prompt_correction', target: 'space.style.zh', title: '修正断言模块', body: '## 断言（修正后全文）', rationale: '1 次人工回滚', sources: [lid] }], notes: [] };
      },
    ]);
    const id = await newBatchId();
    await runSolidifyScan(id, { client: stub as never });
    const lesson = (await pool.query(`SELECT * FROM assistant_failure_lessons`)).rows[0]!;
    expect(lesson.status).toBe('active');
    expect(lesson.signals[0]).toMatchObject({ type: 'rollback', refId: '2' });
    expect(JSON.stringify(stub.calls[1])).toContain(lesson.id);
    const p = (await pool.query(`SELECT * FROM assistant_solidify_proposals`)).rows[0]!;
    expect(p.kind).toBe('prompt_correction');
    expect(p.base_seq).not.toBeNull();
    expect(p.sources[0]).toMatchObject({ type: 'lesson', id: lesson.id, attribution: 'prompt', retireRecommended: false });
    const summary = JSON.parse((await batchRow(id)).input_summary as string);
    expect(summary).toMatchObject({ lessons: 1, signals: 2, proposals: 1 });
  });

  it('platform 归因教训入库但不进 call#2 输入', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    await seedRollbackSignal();
    const stub = sequentialStub([
      { lessons: [
        { attribution: 'platform', title: 'locator 闸门误杀', lesson: '现象:…', signalRefs: ['rollback#4'] },
        { attribution: 'prompt', title: '断言未限定', lesson: '现象:…', signalRefs: ['rollback#2'] },
      ], notes: [] },
      { proposals: [], notes: [] },
    ]);
    const id = await newBatchId();
    await runSolidifyScan(id, { client: stub as never });
    const rows = (await pool.query(`SELECT attribution FROM assistant_failure_lessons`)).rows;
    expect(rows.map((r) => r.attribution).sort()).toEqual(['platform', 'prompt']);
    expect(JSON.stringify(stub.calls[1])).toContain('断言未限定');
    expect(JSON.stringify(stub.calls[1])).not.toContain('locator 闸门误杀');
  });

  it('call#1 整体失败 → 降级不炸批次（done + note + 信号保留）', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    await seedRollbackSignal();
    const stub = sequentialStub([
      { lessons: '不是数组' },
      { proposals: [], notes: [] },
    ]);
    const id = await newBatchId();
    await runSolidifyScan(id, { client: stub as never });
    const b = await batchRow(id);
    expect(b.status).toBe('done');
    const summary = JSON.parse(b.input_summary as string);
    expect(summary.notes.some((n: string) => n.includes('教训蒸馏失败'))).toBe(true);
    const n = (await pool.query(`SELECT count(*)::int n FROM assistant_failure_lessons`)).rows[0]!;
    expect(n.n).toBe(0);
  });

  it('prompt_correction target=skill.* → 无落点丢弃；混入 memory id 的 sources 被修剪剔空丢弃', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    const { memoryId } = await seedSources();
    await seedRollbackSignal();
    const stub = sequentialStub([
      { lessons: [{ attribution: 'prompt', title: 't', lesson: 'l', signalRefs: ['rollback#2'] }], notes: [] },
      async () => {
        const lid = (await pool.query(`SELECT id FROM assistant_failure_lessons LIMIT 1`)).rows[0]!.id as string;
        return { proposals: [
          { kind: 'prompt_correction', target: 'skill.demo', title: '改skill', body: 'x', rationale: 'r', sources: [lid] },
          { kind: 'prompt_correction', target: 'space.style.zh', title: '引用混用', body: 'x', rationale: 'r', sources: [memoryId] },
        ], notes: [] };
      },
    ]);
    const id = await newBatchId();
    await runSolidifyScan(id, { client: stub as never });
    const titles = (await pool.query(`SELECT title FROM assistant_solidify_proposals`)).rows;
    expect(titles).toHaveLength(0);
    const summary = JSON.parse((await batchRow(id)).input_summary as string);
    expect(summary.notes.some((n: string) => n.includes('无落点'))).toBe(true);
    expect(summary.notes.filter((n: string) => n.includes('全部无效')).length).toBe(1);
  });

  it('已被 pending 提案引用的教训，第二次盘点不进输入（同案防重）', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    await seedRollbackSignal();
    const first = sequentialStub([
      { lessons: [{ attribution: 'prompt', title: '教训A', lesson: 'l', signalRefs: ['rollback#2'] }], notes: [] },
      async () => {
        const lid = (await pool.query(`SELECT id FROM assistant_failure_lessons LIMIT 1`)).rows[0]!.id as string;
        return { proposals: [{ kind: 'prompt_correction', target: 'space.style.zh', title: '提案1', body: 'b', rationale: 'r', sources: [lid] }], notes: [] };
      },
    ]);
    await runSolidifyScan(await newBatchId(), { client: first as never });
    // Seed one more asset: otherwise the second scan has consumed signals + empty assets → early exit, and even call#2 would never happen
    await seedSources();
    const second = sequentialStub([{ lessons: [], notes: [] }, { proposals: [], notes: [] }]);
    await runSolidifyScan(await newBatchId(), { client: second as never });
    // Second scan's signals already consumed → phase 1 skipped → asset distillation is the last call
    expect(JSON.stringify(second.calls[second.calls.length - 1])).not.toContain('教训A');
  });
});

// ── R3.6 session signals ──

/** Suspicious-session JSONL (same style as failure-lessons.test: 3 consecutive verify loops + 31min duration → suspicion score 7). */
function suspiciousJsonl(firstUserText = '首条需求：核查SOC事件列表'): string {
  const t0 = Date.parse('2026-11-01T10:00:00Z');
  const at = (min: number) => new Date(t0 + min * 60_000).toISOString();
  const line = (role: string, content: unknown[], extra: Record<string, unknown> = {}, ts = at(0)) =>
    JSON.stringify({ type: 'message', timestamp: ts, message: { role, content, ...extra } });
  const lines = [line('user', [{ type: 'text', text: firstUserText }])];
  for (let i = 1; i <= 3; i++) {
    lines.push(line('assistant', [{ type: 'toolCall', id: `c${i}`, name: 'verify_case', arguments: { caseId: 'loc-1' } }], {}, at(i * 10)));
    lines.push(line('toolResult', [{ type: 'text', text: 'r' }], { toolCallId: `c${i}`, toolName: 'verify_case', isError: false }, at(i * 10 + 1)));
  }
  return lines.join('\n');
}

/** Insert a chat thread + write JSONL. pi_thread_id uses a bare uuid (not an absolute path) — forcing findSessionFile down the
 *  readdir fallback, making SolidifyRunDeps.sessionsRoot's DI part of the test payload (an absolute path would bypass DI and probe directly).
 *  updated_at uses a UTC wall-clock string (same semantics as the drizzle write path); returns the test-held Date as the source of truth. */
async function seedChatThread(firstUserText?: string): Promise<{ id: string; updatedAt: Date }> {
  const uuid = randomUUID();
  await writeFile(join(sessionsRoot, `sess_${uuid}.jsonl`), suspiciousJsonl(firstUserText));
  const updatedAt = new Date(Date.parse('2026-11-01T12:00:00Z'));
  const id = (await pool.query(
    `INSERT INTO ai_threads (pi_thread_id, purpose, updated_at, created_at) VALUES ($1, 'chat', $2, $2) RETURNING id`,
    [uuid, updatedAt.toISOString().slice(0, 19).replace('T', ' ')])).rows[0]!.id as string;
  return { id, updatedAt };
}

describe('runSolidifyScan：R3.6 会话信号', () => {
  it('可疑会话 fixture → call#1 输入含 type=session 信号（SolidifyRunDeps.sessionsRoot 透传）', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    await seedChatThread();
    const stub = sequentialStub([{ lessons: [], notes: [] }, { proposals: [], notes: [] }]);
    const id = await newBatchId();
    await runSolidifyScan(id, { client: stub as never, sessionsRoot });
    expect(stub.calls).toHaveLength(2); // signals present → no early exit, distillation called twice
    expect(JSON.stringify(stub.calls[0])).toContain('type=session');
    expect(JSON.stringify(stub.calls[0])).toContain('首条需求：核查SOC事件列表');
    const summary = JSON.parse((await batchRow(id)).input_summary as string);
    expect(summary).toMatchObject({ signals: 1 });
  });

  it('会话信号归 platform → 教训入库但不进 call#2 输入（三道闸第二道）', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    const t = await seedChatThread();
    const refId = `session#${t.id}#${t.updatedAt.getTime()}`;
    const stub = sequentialStub([
      { lessons: [{ attribution: 'platform', title: '网关停顿慢会话', lesson: '现象:…根因:…', signalRefs: [refId] }], notes: [] },
      { proposals: [], notes: [] },
    ]);
    const id = await newBatchId();
    await runSolidifyScan(id, { client: stub as never, sessionsRoot });
    const lesson = (await pool.query(`SELECT * FROM assistant_failure_lessons`)).rows[0]!;
    expect(lesson.attribution).toBe('platform');
    expect(lesson.signals[0]).toMatchObject({ type: 'session', refId });
    expect(JSON.stringify(stub.calls[1])).not.toContain('网关停顿慢会话');
    const summary = JSON.parse((await batchRow(id)).input_summary as string);
    expect(summary).toMatchObject({ lessons: 0, signals: 1 });
  });

  it('会话信号归 prompt → 教训进 call#2 → prompt_correction 提案 sources 引用会话教训', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    const t = await seedChatThread();
    const refId = `session#${t.id}#${t.updatedAt.getTime()}`;
    const stub = sequentialStub([
      { lessons: [{ attribution: 'prompt', title: 'verify 死循环引导缺陷', lesson: '现象:…建议:…', signalRefs: [refId] }], notes: [] },
      async () => {
        const lid = (await pool.query(`SELECT id FROM assistant_failure_lessons LIMIT 1`)).rows[0]!.id as string;
        return { proposals: [{ kind: 'prompt_correction', target: 'space.style.zh', title: '修正死循环引导', body: '## 全文', rationale: '1 条 session 会话证据教训', sources: [lid] }], notes: [] };
      },
    ]);
    const id = await newBatchId();
    await runSolidifyScan(id, { client: stub as never, sessionsRoot });
    expect(JSON.stringify(stub.calls[1])).toContain('verify 死循环引导缺陷');
    const p = (await pool.query(`SELECT * FROM assistant_solidify_proposals`)).rows[0]!;
    expect(p.kind).toBe('prompt_correction');
    expect(p.sources[0]).toMatchObject({ type: 'lesson', attribution: 'prompt', signalCount: 1 });
  });

  it('采集器 note（>8MB 跳过）并入批次 summary.notes（早退路径除外）', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    await seedSources(); // non-empty asset pool prevents early exit
    const uuid = randomUUID();
    await writeFile(join(sessionsRoot, `sess_${uuid}.jsonl`), 'x'.repeat(9 * 1024 * 1024)); // content irrelevant — skipped by size first
    await pool.query(`INSERT INTO ai_threads (pi_thread_id, purpose, updated_at, created_at) VALUES ($1, 'chat', $2, $2)`,
      [uuid, '2026-11-01 12:00:00']);
    const stub = sequentialStub([{ proposals: [], notes: [] }]); // 0 signals → no phase 1, only one asset distillation call
    const id = await newBatchId();
    await runSolidifyScan(id, { client: stub as never, sessionsRoot });
    const summary = JSON.parse((await batchRow(id)).input_summary as string);
    expect(summary.notes.some((n: string) => n.includes('8MB'))).toBe(true);
  });
});

// ── Channel maxTokens wiring (2026-11-01 prod228 field-verified regression anchor) ──
// Production bug: the internally constructed client hand-rolled its fields and dropped cfg.maxTokens → the gateway
// thinking model burned its entire budget in the default 4096 → empty text, distillation always failed; setting 16384
// on the settings page had no effect either. Anchor: do not inject deps.client; take the real
// readLlmConfig → getLlmClient path, and the request body must pass through the configured max_tokens.
describe('runSolidifyScan：内部建 client 透传渠道 maxTokens', () => {
  it('渠道配 maxTokens=16384 → Anthropic 请求体 max_tokens=16384（而非默认 4096）', async () => {
    await seedLlmChannel(pool, { provider: 'anthropic', apiKey: 'sk-test', model: 'm', maxTokens: 16384 });
    createMock.mockResolvedValueOnce({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'm',
      content: [{ type: 'text', text: JSON.stringify({ proposals: [], notes: [] }) }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    await seedSources(); // non-empty asset pool prevents early exit (0 signals → no phase 1, only one asset distillation call)
    const id = await newBatchId();
    await runSolidifyScan(id, { sessionsRoot }); // no client injected → internal readLlmConfig builds the client
    const b = await batchRow(id);
    expect(b.status).toBe('done');
    expect(createMock).toHaveBeenCalledTimes(1);
    const body = createMock.mock.calls[0]![0] as { max_tokens: number };
    expect(body.max_tokens).toBe(16384);
  });
});
