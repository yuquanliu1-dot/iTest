/** R3.5 蒸馏层：S1/S2/S3 信号聚合与消费幂等/教训蒸馏校验/提案输入过滤。 */
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
  await pool.query(`TRUNCATE assistant_failure_signals, assistant_failure_lessons, assistant_solidify_proposals, assistant_solidify_batches, assistant_prompt_module_versions, ai_assistant_feedback`);
});

/** 顺序计数 stub：按调用次序回放 value；记录每次入参（形状无关断言用 JSON.stringify）。 */
function sequentialStub(values: Array<unknown | ((prevReq: unknown) => unknown)>) {
  let i = 0;
  const calls: unknown[] = [];
  return {
    provider: 'openai' as const,
    calls,
    complete: async (req: unknown) => {
      calls.push(req);
      const raw = values[Math.min(i, values.length - 1)];
      const v = typeof raw === 'function' ? (raw as (r: unknown) => unknown)(calls[calls.length - 2] ?? req) : raw;
      i += 1;
      return { kind: 'json' as const, value: v, provider: 'openai' as const, vision: false, model: 'stub-model' };
    },
  };
}

async function seedRollback(moduleKey: string, badValue: string, source: 'rollback' | 'manual_edit', newValue: string | null): Promise<number> {
  const bad = (await pool.query(
    `INSERT INTO assistant_prompt_module_versions (module_key, value, source) VALUES ($1, $2, 'baseline') RETURNING seq`,
    [moduleKey, badValue])).rows[0]!.seq as number;
  const rolled = (await pool.query(
    `INSERT INTO assistant_prompt_module_versions (module_key, value, source) VALUES ($1, $2, $3) RETURNING seq`,
    [moduleKey, newValue, source])).rows[0]!.seq as number;
  void bad;
  return rolled;
}

describe('collectUnconsumedSignals', () => {
  it('S1：回滚行→信号（refId=seq，excerpt 含被放弃文案与现值）；restore_default 同理', async () => {
    const { collectUnconsumedSignals } = await import('../src/pi/space/failureLessons.js');
    const seq1 = await seedRollback('space.style.zh', '断言未限定实测范围的旧表述', 'rollback', '修正后的值');
    const seq2 = await seedRollback('tool.t1.guidelines', '旧指引', 'manual_edit', null);
    const { signals } = await collectUnconsumedSignals();
    const s1 = signals.find((s) => s.refId === String(seq1))!;
    expect(s1.type).toBe('rollback');
    expect(s1.key).toBe(`rollback#${seq1}`);
    expect(s1.excerpt).toContain('断言未限定实测范围的旧表述');
    expect(s1.excerpt).toContain('修正后的值');
    const s2 = signals.find((s) => s.refId === String(seq2))!;
    expect(s2.type).toBe('restore_default');
  });

  it('S1 selfSolidify：被回滚行 source=solidify_apply → 旗标置位（R3 自身输出质量反馈）', async () => {
    const { collectUnconsumedSignals } = await import('../src/pi/space/failureLessons.js');
    await pool.query(
      `INSERT INTO assistant_prompt_module_versions (module_key, value, source) VALUES ('space.style.zh', '固化产出的坏文案', 'baseline')`);
    await pool.query(
      `INSERT INTO assistant_prompt_module_versions (module_key, value, source) VALUES ('space.style.zh', '固化产出的坏文案', 'solidify_apply')`);
    const rolled = (await pool.query(
      `INSERT INTO assistant_prompt_module_versions (module_key, value, source) VALUES ('space.style.zh', '回退值', 'rollback') RETURNING seq`)).rows[0]!.seq as number;
    const { signals } = await collectUnconsumedSignals();
    const s = signals.find((x) => x.refId === String(rolled))!;
    expect(s.selfSolidify).toBe(true);
    expect(s.title).toContain('固化');
  });

  it('消费幂等：已被教训 signals 引用的 refId 不再出现（任意 status：retired 也不复活）', async () => {
    const { collectUnconsumedSignals } = await import('../src/pi/space/failureLessons.js');
    const seq = await seedRollback('space.style.zh', '坏', 'rollback', '好');
    await pool.query(
      `INSERT INTO assistant_failure_lessons (status, attribution, title, lesson, signals, distill_model)
       VALUES ('retired', 'prompt', 't', 'l', $1::jsonb, 'm')`,
      [JSON.stringify([{ type: 'rollback', refId: String(seq), excerpt: 'e' }])]);
    const { signals } = await collectUnconsumedSignals();
    expect(signals.find((s) => s.refId === String(seq))).toBeUndefined();
  });

  it('S2：负向反馈→信号带线名；S3：nl_ai_fail→信号带用例上下文', async () => {
    const { collectUnconsumedSignals } = await import('../src/pi/space/failureLessons.js');
    const { projectId, productLineId } = await seedProject(pool);
    await pool.query(
      `INSERT INTO ai_assistant_feedback (thread_id, version_id, project_id, sentiment, message_excerpt, comment)
       VALUES ($1, $2, $3, 'negative', 'AI 瞎说自动登录', '登录明明要自己配')`,
      [randomUUID(), randomUUID(), projectId]);
    await pool.query(
      `INSERT INTO assistant_failure_signals (type, thread_id, case_id, step_order, product_line_id, payload)
       VALUES ('nl_ai_fail', $1, 'case-9', 2, $2, $3::jsonb)`,
      [randomUUID(), productLineId, JSON.stringify({ caseTitle: 'SOC 用例', stepInstruction: '点击新增', failureReason: 'StepTimedOut', pageUrl: 'http://p' })]);
    const { signals } = await collectUnconsumedSignals();
    const s2 = signals.find((s) => s.type === 'negative_feedback')!;
    expect(s2.excerpt).toContain('AI 瞎说自动登录');
    expect(s2.excerpt).toContain('登录明明要自己配');
    const s3 = signals.find((s) => s.type === 'nl_ai_fail')!;
    expect(s3.refId).toBeTruthy();
    expect(s3.excerpt).toContain('点击新增');
  });

  it('cap 60：S1 优先保留，超量截断', async () => {
    const { collectUnconsumedSignals } = await import('../src/pi/space/failureLessons.js');
    const seq = await seedRollback('space.style.zh', '高精度信号', 'rollback', '好');
    for (let i = 0; i < 70; i++) {
      await pool.query(
        `INSERT INTO assistant_failure_signals (type, thread_id, case_id, step_order, payload) VALUES ('nl_ai_fail', $1, $2, 1, '{}')`,
        [randomUUID(), `c${i}`]);
    }
    const { signals, total } = await collectUnconsumedSignals();
    expect(signals).toHaveLength(60);
    expect(total).toBe(71);
    expect(signals.find((s) => s.refId === String(seq))).toBeTruthy(); // S1 没被截掉
  });
});

describe('distillLessons', () => {
  it('产出入库：attribution/title/lesson/signals(refId 溯源)/distillModel', async () => {
    const { collectUnconsumedSignals, distillLessons } = await import('../src/pi/space/failureLessons.js');
    const seq = await seedRollback('space.style.zh', '坏', 'rollback', '好');
    const { signals } = await collectUnconsumedSignals();
    const stub = sequentialStub([{
      lessons: [{ attribution: 'prompt', title: '断言表述未限定实测范围', lesson: '现象:…根因:…影响面:…建议:限定实测范围', signalRefs: [`rollback#${seq}`] }],
      notes: [],
    }]);
    const n = await distillLessons(stub as never, signals, 5_000);
    expect(n).toBe(1);
    const row = (await pool.query(`SELECT * FROM assistant_failure_lessons`)).rows[0]!;
    expect(row.attribution).toBe('prompt');
    expect(row.status).toBe('active');
    expect(row.signals[0]).toMatchObject({ type: 'rollback', refId: String(seq) });
    expect(row.distill_model).toBe('stub-model');
  });

  it('单条不合法丢弃不炸批次；signalRefs 全部无效的条丢弃；有效条保留', async () => {
    const { collectUnconsumedSignals, distillLessons } = await import('../src/pi/space/failureLessons.js');
    const seq = await seedRollback('space.style.zh', '坏', 'rollback', '好');
    const { signals } = await collectUnconsumedSignals();
    const stub = sequentialStub([{
      lessons: [
        { attribution: 'prompt', title: '好', lesson: 'l', signalRefs: [`rollback#${seq}`] },
        { attribution: 'prompt', title: 'refs 全无效', lesson: 'l', signalRefs: ['rollback#99999'] },
        { attribution: 'galaxy', title: '归因非法', lesson: 'l', signalRefs: [`rollback#${seq}`] },
      ],
      notes: [],
    }]);
    const n = await distillLessons(stub as never, signals, 5_000);
    expect(n).toBe(1);
    const titles = (await pool.query(`SELECT title FROM assistant_failure_lessons`)).rows;
    expect(titles.map((r) => r.title)).toEqual(['好']);
  });

  it('LLM 输出整体不合法 → throw（调用方降级处理）', async () => {
    const { distillLessons } = await import('../src/pi/space/failureLessons.js');
    const stub = sequentialStub([{ lessons: '不是数组' }]);
    await expect(distillLessons(stub as never, [], 5_000)).rejects.toThrow();
  });
});

describe('listProposalInputLessons', () => {
  async function seedLesson(attribution: string, title: string): Promise<string> {
    return (await pool.query(
      `INSERT INTO assistant_failure_lessons (attribution, title, lesson, signals, distill_model) VALUES ($1, $2, 'l', '[]', 'm') RETURNING id`,
      [attribution, title])).rows[0]!.id as string;
  }
  async function seedProposalWithLessonSource(lessonId: string, status: string): Promise<void> {
    const b = (await pool.query(`INSERT INTO assistant_solidify_batches (status) VALUES ('done') RETURNING id`)).rows[0]!.id as string;
    await pool.query(
      `INSERT INTO assistant_solidify_proposals (batch_id, kind, target, title, body, rationale, sources, status, distill_model)
       VALUES ($1, 'prompt_correction', 'space.style.zh', 't', 'b', 'r', $2::jsonb, $3, 'm')`,
      [b, JSON.stringify([{ type: 'lesson', id: lessonId, title: 'x', lineName: '', retireRecommended: false }]), status]);
  }

  it('只取 prompt/step_description 的 active；platform/sut 不进输入', async () => {
    const { listProposalInputLessons } = await import('../src/pi/space/failureLessons.js');
    await seedLesson('prompt', 'p');
    await seedLesson('step_description', 's');
    await seedLesson('platform', 'pf');
    await seedLesson('sut', 'su');
    const out = await listProposalInputLessons();
    expect(out.map((l) => l.title).sort()).toEqual(['p', 's']);
  });

  it('被 pending/approved 提案引用的教训 blocked；rejected 引用的回输入且 previouslyRejected=true', async () => {
    const { listProposalInputLessons } = await import('../src/pi/space/failureLessons.js');
    const pending = await seedLesson('prompt', '待审批占用');
    const rejected = await seedLesson('prompt', '曾被驳回');
    await seedProposalWithLessonSource(pending, 'pending');
    await seedProposalWithLessonSource(rejected, 'rejected');
    const out = await listProposalInputLessons();
    expect(out.find((l) => l.id === pending)).toBeUndefined();
    const r = out.find((l) => l.id === rejected)!;
    expect(r.previouslyRejected).toBe(true);
  });
});
