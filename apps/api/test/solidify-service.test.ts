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
  await pool.query(`TRUNCATE assistant_solidify_proposals, assistant_solidify_batches, assistant_memories, assistant_trajectories, assistant_skills, settings`);
});

/** stub LLM client：completeJson 首轮 kind:'json' 即透传 value/model（trajectory-worker.test 同款）。 */
function stubClient(value: unknown) {
  return {
    provider: 'openai' as const,
    complete: async () => ({ kind: 'json' as const, value, provider: 'openai' as const, vision: false, model: 'stub-model' }),
  };
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
