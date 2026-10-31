/** 审批执行：乐观锁/prompt 追加+baseline/skill 先写盘后记行+幂等重放/退役守卫/部分失败回 pending。 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let tmpDataDir: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  tmpDataDir = mkdtempSync(join(tmpdir(), 'itest-sa-'));
  process.env.PI_DATA_DIR = tmpDataDir;
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await pool.query(`TRUNCATE assistant_solidify_proposals, assistant_solidify_batches, assistant_prompt_module_versions, assistant_memories, assistant_trajectories, assistant_skills`);
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

async function seedProposal(opts: { kind: 'prompt_amendment' | 'skill_revision'; target: string; sourceIds: Array<{ type: 'memory' | 'trajectory'; id: string }> }): Promise<string> {
  const batchId = await seedBatch();
  return (await pool.query(
    `INSERT INTO assistant_solidify_proposals (batch_id, kind, target, title, body, rationale, sources, distill_model)
     VALUES ($1, $2, $3, '提案', $4, 'r', $5::jsonb, 'm') RETURNING id`,
    [batchId, opts.kind, opts.target, opts.kind === 'skill_revision' ? '修订后正文' : '- 增量文案',
     JSON.stringify(opts.sourceIds.map((s) => ({ type: s.type, id: s.id, title: 'src', retireRecommended: s.type === 'memory' })))],
  )).rows[0]!.id as string;
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
    expect(rows[0].value).toContain('## 输出风格'); // 代码默认被钉住
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
    // 模拟「应用成功但 appliedAt 未落」的部分失败：回 pending 再批
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
    expect(m.status).toBe('retired_manual'); // WHERE status='active' 守卫：不改已退役行
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
