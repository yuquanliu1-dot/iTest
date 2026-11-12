/** Approval execution: optimistic lock / prompt append+baseline / skill written to disk before recording rows + idempotent replay / retirement guards / partial failure back to pending. */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let pool: Pool;
let tmpDataDir: string;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  tmpDataDir = mkdtempSync(join(tmpdir(), 'itest-sa-'));
  process.env.PI_DATA_DIR = tmpDataDir;
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await pool.query(`TRUNCATE assistant_solidify_proposals, assistant_solidify_batches, assistant_prompt_module_versions, assistant_memories, assistant_trajectories, assistant_skills, assistant_failure_lessons`);
});

async function seedBatch(): Promise<string> {
  return (await pool.query(`INSERT INTO assistant_solidify_batches (status) VALUES ('done') RETURNING id`)).rows[0]!.id as string;
}

async function seedSources(): Promise<{ memoryId: string; trajectoryId: string }> {
  const { productLineId: lineId } = await seedProject(pool);
  const memoryId = randomUUID();
  const trajectoryId = randomUUID();
  await pool.query(`INSERT INTO assistant_memories (id, scope, product_line_id, title, hook, provenance) VALUES ($1, 'product_line', $2, 'm', 'h', 'ai_inferred')`, [memoryId, lineId]);
  await pool.query(`INSERT INTO assistant_trajectories (id, product_line_id, task_title, task_keywords, digest, case_title, distill_model) VALUES ($1, $2, 't', 'k', 'd', 'c', 'm')`, [trajectoryId, lineId]);
  return { memoryId, trajectoryId };
}

async function seedProposal(opts: {
  kind: 'prompt_amendment' | 'skill_revision' | 'prompt_correction';
  target: string;
  sourceIds: Array<{ type: 'memory' | 'trajectory' | 'lesson'; id: string }>;
  baseSeq?: number | null;
}): Promise<string> {
  const batchId = await seedBatch();
  return (await pool.query(
    `INSERT INTO assistant_solidify_proposals (batch_id, kind, target, title, body, rationale, sources, base_seq, distill_model)
     VALUES ($1, $2, $3, '提案', $4, 'r', $5::jsonb, $6, 'm') RETURNING id`,
    [batchId, opts.kind, opts.target,
     opts.kind === 'skill_revision' ? '修订后正文' : opts.kind === 'prompt_correction' ? '修正后全文' : '- 增量文案',
     JSON.stringify(opts.sourceIds.map((s) => ({
       type: s.type, id: s.id, title: 'src', lineName: s.type === 'lesson' ? '' : '线',
       retireRecommended: s.type === 'memory',
       ...(s.type === 'lesson' ? { attribution: 'prompt', signalCount: 2 } : {}),
     }))),
     opts.kind === 'prompt_correction' ? (opts.baseSeq ?? null) : null,
    ])).rows[0]!.id as string;
}

async function seedLesson(): Promise<string> {
  return (await pool.query(
    `INSERT INTO assistant_failure_lessons (attribution, title, lesson, signals, distill_model) VALUES ('prompt', '教训', 'l', '[]', 'm') RETURNING id`)).rows[0]!.id as string;
}

async function seedSkill(name = 'demo-skill') {
  await pool.query(`INSERT INTO assistant_skills (name, description) VALUES ($1, '演示技能')`, [name]);
  const dir = join(tmpDataDir, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${JSON.stringify(name)}\ndescription: "演示技能"\n---\n\n旧正文`);
}

describe('approveProposal：prompt_amendment', () => {
  it('无版本行 → 先 baseline（代码默认）再追加增量；appliedAt 落值', async () => {
    const { approveProposal } = await import('../src/pi/space/solidifyApply.js');
    const { memoryId } = await seedSources();
    const id = await seedProposal({ kind: 'prompt_amendment', target: 'space.style.zh', sourceIds: [{ type: 'memory', id: memoryId }] });
    await approveProposal(null, id, []);
    const rows = (await pool.query(`SELECT * FROM assistant_prompt_module_versions ORDER BY seq`)).rows;
    expect(rows.length).toBe(2);
    expect(rows[0].source).toBe('baseline');
    expect(rows[0].value).toContain('## 输出风格'); // code default is pinned
    expect(rows[1].source).toBe('solidify_apply');
    expect(rows[1].value).toBe(`${rows[0].value}\n\n- 增量文案`);
    expect(rows[1].source_ref).toBe(id);
    const p = (await pool.query(`SELECT * FROM assistant_solidify_proposals WHERE id=$1`, [id])).rows[0]!;
    expect(p.status).toBe('approved');
    expect(p.applied_at).toBeTruthy();
  });

  it('有手工行 → 在当前值尾部追加（不落 baseline）', async () => {
    const { approveProposal } = await import('../src/pi/space/solidifyApply.js');
    const { memoryId } = await seedSources();
    await pool.query(`INSERT INTO assistant_prompt_module_versions (module_key, value, source) VALUES ('space.style.zh', '旧文案', 'manual_edit')`);
    const id = await seedProposal({ kind: 'prompt_amendment', target: 'space.style.zh', sourceIds: [{ type: 'memory', id: memoryId }] });
    await approveProposal(null, id, []);
    const rows = (await pool.query(`SELECT * FROM assistant_prompt_module_versions ORDER BY seq`)).rows;
    expect(rows.length).toBe(2);
    expect(rows[1].value).toBe('旧文案\n\n- 增量文案');
  });

  it('部分失败后重试：sourceRef 行已存在 → 跳过写值，不重复落行', async () => {
    const { approveProposal } = await import('../src/pi/space/solidifyApply.js');
    const { memoryId } = await seedSources();
    const id = await seedProposal({ kind: 'prompt_amendment', target: 'space.style.zh', sourceIds: [{ type: 'memory', id: memoryId }] });
    await approveProposal(null, id, []);
    // Simulate the partial failure of "apply succeeded but appliedAt not recorded": back to pending, then approve again
    await pool.query(`UPDATE assistant_solidify_proposals SET status='pending', applied_at=null WHERE id=$1`, [id]);
    await approveProposal(null, id, []);
    const n = (await pool.query(`SELECT count(*)::int n FROM assistant_prompt_module_versions WHERE source_ref=$1`, [id])).rows[0]!;
    expect(n.n).toBe(1);
  });
});

describe('approveProposal：skill_revision', () => {
  it('先写文件（frontmatter 从 DB 重拼）再记 baseline+apply 行', async () => {
    const { approveProposal } = await import('../src/pi/space/solidifyApply.js');
    const { memoryId } = await seedSources();
    await seedSkill();
    const id = await seedProposal({ kind: 'skill_revision', target: 'demo-skill', sourceIds: [{ type: 'memory', id: memoryId }] });
    await approveProposal(null, id, []);
    const md = readFileSync(join(tmpDataDir, 'skills', 'demo-skill', 'SKILL.md'), 'utf8');
    expect(md).toBe('---\nname: "demo-skill"\ndescription: "演示技能"\n---\n\n修订后正文');
    const rows = (await pool.query(`SELECT * FROM assistant_prompt_module_versions ORDER BY seq`)).rows;
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ module_key: 'skill.demo-skill', value: '旧正文', source: 'baseline' });
    expect(rows[1]).toMatchObject({ module_key: 'skill.demo-skill', value: '修订后正文', source: 'solidify_apply', source_ref: id });
  });

  it('skill 不存在 → 500 + 提案回 pending + apply_error', async () => {
    const { approveProposal } = await import('../src/pi/space/solidifyApply.js');
    const { memoryId } = await seedSources();
    const id = await seedProposal({ kind: 'skill_revision', target: 'ghost-skill', sourceIds: [{ type: 'memory', id: memoryId }] });
    await expect(approveProposal(null, id, [])).rejects.toMatchObject({ status: 500 });
    const p = (await pool.query(`SELECT * FROM assistant_solidify_proposals WHERE id=$1`, [id])).rows[0]!;
    expect(p.status).toBe('pending');
    expect(p.apply_error).toContain('ghost-skill');
  });
});

describe('approveProposal：退役与守卫', () => {
  it('retireIds 勾选 memory → retired_solidified+retired_by_batch；未勾 trajectory 保持 active', async () => {
    const { approveProposal } = await import('../src/pi/space/solidifyApply.js');
    const src = await seedSources();
    const id = await seedProposal({ kind: 'prompt_amendment', target: 'space.style.zh', sourceIds: [{ type: 'memory', id: src.memoryId }, { type: 'trajectory', id: src.trajectoryId }] });
    await approveProposal(null, id, [src.memoryId]);
    const m = (await pool.query(`SELECT * FROM assistant_memories WHERE id=$1`, [src.memoryId])).rows[0]!;
    expect(m.status).toBe('retired_solidified');
    expect(m.retired_by_batch).toBeTruthy();
    const t = (await pool.query(`SELECT * FROM assistant_trajectories WHERE id=$1`, [src.trajectoryId])).rows[0]!;
    expect(t.status).toBe('active');
  });

  it('retireIds 越界（非本提案 sources）→ 400', async () => {
    const { approveProposal } = await import('../src/pi/space/solidifyApply.js');
    const { memoryId } = await seedSources();
    const id = await seedProposal({ kind: 'prompt_amendment', target: 'space.style.zh', sourceIds: [{ type: 'memory', id: memoryId }] });
    await expect(approveProposal(null, id, [randomUUID()])).rejects.toMatchObject({ status: 400 });
  });

  it('非 pending（已批）→ 409；不重复应用', async () => {
    const { approveProposal } = await import('../src/pi/space/solidifyApply.js');
    const { memoryId } = await seedSources();
    const id = await seedProposal({ kind: 'prompt_amendment', target: 'space.style.zh', sourceIds: [{ type: 'memory', id: memoryId }] });
    await approveProposal(null, id, []);
    await expect(approveProposal(null, id, [])).rejects.toMatchObject({ status: 409 });
  });

  it('退役 active 守卫：已 retired 的源不复活不重复计', async () => {
    const { approveProposal } = await import('../src/pi/space/solidifyApply.js');
    const src = await seedSources();
    await pool.query(`UPDATE assistant_memories SET status='retired_manual' WHERE id=$1`, [src.memoryId]);
    const id = await seedProposal({ kind: 'prompt_amendment', target: 'space.style.zh', sourceIds: [{ type: 'memory', id: src.memoryId }] });
    await approveProposal(null, id, [src.memoryId]);
    const m = (await pool.query(`SELECT * FROM assistant_memories WHERE id=$1`, [src.memoryId])).rows[0]!;
    expect(m.status).toBe('retired_manual'); // WHERE status='active' guard: retired rows are not touched
  });
});

describe('rejectProposal', () => {
  it('驳回：status=rejected，不碰任何资产', async () => {
    const { rejectProposal } = await import('../src/pi/space/solidifyApply.js');
    const { memoryId } = await seedSources();
    const id = await seedProposal({ kind: 'prompt_amendment', target: 'space.style.zh', sourceIds: [{ type: 'memory', id: memoryId }] });
    await rejectProposal(null, id);
    const p = (await pool.query(`SELECT * FROM assistant_solidify_proposals WHERE id=$1`, [id])).rows[0]!;
    expect(p.status).toBe('rejected');
    const n = (await pool.query(`SELECT count(*)::int n FROM assistant_prompt_module_versions`)).rows[0]!;
    expect(n.n).toBe(0);
    await expect(rejectProposal(null, id)).rejects.toMatchObject({ status: 409 });
  });
});

describe('approveProposal：prompt_correction', () => {
  it('应用=全文覆盖写版本行（source=solidify_apply+sourceRef 幂等）；lesson 置 resolved', async () => {
    const { approveProposal } = await import('../src/pi/space/solidifyApply.js');
    await pool.query(`INSERT INTO assistant_prompt_module_versions (module_key, value, source) VALUES ('space.style.zh', '当前值', 'manual_edit')`);
    const current = (await pool.query(`SELECT seq FROM assistant_prompt_module_versions WHERE module_key='space.style.zh' ORDER BY seq DESC LIMIT 1`)).rows[0]!.seq as number;
    const lessonId = await seedLesson();
    const id = await seedProposal({ kind: 'prompt_correction', target: 'space.style.zh', sourceIds: [{ type: 'lesson', id: lessonId }], baseSeq: current });
    await approveProposal(null, id, []);
    const row = (await pool.query(`SELECT * FROM assistant_prompt_module_versions ORDER BY seq DESC LIMIT 1`)).rows[0]!;
    expect(row).toMatchObject({ module_key: 'space.style.zh', value: '修正后全文', source: 'solidify_apply', source_ref: id });
    const lesson = (await pool.query(`SELECT * FROM assistant_failure_lessons WHERE id=$1`, [lessonId])).rows[0]!;
    expect(lesson.status).toBe('resolved');
    expect(lesson.resolved_by_proposal).toBe(id);
  });

  it('baseSeq 冲突（盘点后被人工改过）→ apply_error「人工修改」+ status 回 pending + 500', async () => {
    const { approveProposal } = await import('../src/pi/space/solidifyApply.js');
    const lessonId = await seedLesson();
    const id = await seedProposal({ kind: 'prompt_correction', target: 'space.style.zh', sourceIds: [{ type: 'lesson', id: lessonId }], baseSeq: 7 });
    // After the inventory, a manual edit advanced the state again → current max(seq) moved forward
    await pool.query(`INSERT INTO assistant_prompt_module_versions (module_key, value, source) VALUES ('space.style.zh', '人工改过', 'manual_edit')`);
    await expect(approveProposal(null, id, [])).rejects.toMatchObject({ status: 500 });
    const p = (await pool.query(`SELECT * FROM assistant_solidify_proposals WHERE id=$1`, [id])).rows[0]!;
    expect(p.status).toBe('pending');
    expect(p.apply_error).toContain('人工修改');
    const n = (await pool.query(`SELECT count(*)::int n FROM assistant_prompt_module_versions WHERE source_ref=$1`, [id])).rows[0]!;
    expect(n.n).toBe(0); // no version rows written
    const lesson = (await pool.query(`SELECT status FROM assistant_failure_lessons WHERE id=$1`, [lessonId])).rows[0]!;
    expect(lesson.status).toBe('active'); // the lesson is not mistakenly resolved
  });

  it('重试重放：sourceRef 行已存在 → 跳过写值继续（lesson 补 resolved）', async () => {
    const { approveProposal } = await import('../src/pi/space/solidifyApply.js');
    const lessonId = await seedLesson();
    const id = await seedProposal({ kind: 'prompt_correction', target: 'space.style.zh', sourceIds: [{ type: 'lesson', id: lessonId }], baseSeq: null });
    await approveProposal(null, id, []);
    // Simulate the partial failure of "version row written but lesson not resolved": back to pending, then approve again
    await pool.query(`UPDATE assistant_solidify_proposals SET status='pending', applied_at=null WHERE id=$1`, [id]);
    await approveProposal(null, id, []);
    const n = (await pool.query(`SELECT count(*)::int n FROM assistant_prompt_module_versions WHERE source_ref=$1`, [id])).rows[0]!;
    expect(n.n).toBe(1);
    const lesson = (await pool.query(`SELECT status FROM assistant_failure_lessons WHERE id=$1`, [lessonId])).rows[0]!;
    expect(lesson.status).toBe('resolved');
  });

  it('target=skill.*（绕过盘点直插 DB）→ 应用拒绝', async () => {
    const { approveProposal } = await import('../src/pi/space/solidifyApply.js');
    const lessonId = await seedLesson();
    const id = await seedProposal({ kind: 'prompt_correction', target: 'skill.demo', sourceIds: [{ type: 'lesson', id: lessonId }], baseSeq: null });
    await expect(approveProposal(null, id, [])).rejects.toMatchObject({ status: 500 });
    const p = (await pool.query(`SELECT * FROM assistant_solidify_proposals WHERE id=$1`, [id])).rows[0]!;
    expect(p.apply_error).toContain('不在注册表');
  });
});
