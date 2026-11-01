/** 固化盘点管线：防重入/LLM 未配置/空输入/蒸馏入库/单条丢弃/超时/无落点。 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  // RESTART IDENTITY：R3.5 用例硬编码 rollback#2/refId '2'，bigserial 须每例从 1 重来。
  await pool.query(`TRUNCATE assistant_solidify_proposals, assistant_solidify_batches, assistant_memories, assistant_trajectories, assistant_skills, assistant_failure_signals, assistant_failure_lessons, assistant_prompt_module_versions, settings RESTART IDENTITY`);
});

/** stub LLM client：completeJson 首轮 kind:'json' 即透传 value/model（trajectory-worker.test 同款）。 */
function stubClient(value: unknown) {
  return {
    provider: 'openai' as const,
    complete: async () => ({ kind: 'json' as const, value, provider: 'openai' as const, vision: false, model: 'stub-model' }),
  };
}

/** 顺序计数 stub：call#1=教训蒸馏、call#2=资产蒸馏，按次序回放；记录入参（JSON.stringify 断言）。
 *  函数值支持 async（教训行在 call#1 处理期间才入库，call#2 回调须查库取教训 id）。 */
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

/** seed 一轮「人工回滚 + 恢复默认」版本链（S1 信号源）：seq 2=rollback，seq 4=restore_default。 */
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
    await runSolidifyScan(id); // 测试库 settings 空 → readLlmConfig null
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
        { kind: 'prompt_amendment', target: 'space.style.zh', /* 缺 body */ title: '坏', rationale: 'r', sources: [memoryId] },
      ],
      notes: [],
    }) });
    const b = await batchRow(id);
    expect(b.status).toBe('done'); // 不 failed
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
    // 系统提示词本身含「【失败教训】」指令文案；红线锚定的是输入节标志——零信号时
    // 【失败教训】节（节头 + [L1] 条目）不出现。
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
    // 补一条资产：否则第二次扫描信号已消费+资产为空 → 早退，连 call#2 都不会发生
    await seedSources();
    const second = sequentialStub([{ lessons: [], notes: [] }, { proposals: [], notes: [] }]);
    await runSolidifyScan(await newBatchId(), { client: second as never });
    // 第二次扫描信号已消费 → 阶段 1 跳过 → 资产蒸馏是最后一次调用
    expect(JSON.stringify(second.calls[second.calls.length - 1])).not.toContain('教训A');
  });
});
