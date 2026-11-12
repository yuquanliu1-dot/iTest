/**
 * Trajectory distillation worker orchestration: evidence verification (verify_case success chain) → LLM distillation → idempotent persistence.
 * The stub LLM client always returns valid distillation JSON; the three failure paths — evidence unmet /
 * file missing / output invalid — must all be silently discarded (design §4.2: no retry, no blocking).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let pool: Pool;
const tmpRoots: string[] = [];

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  await import('../src/db/client.js');
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  tmpRoots.forEach((r) => rmSync(r, { recursive: true, force: true }));
});

beforeEach(async () => {
  await pool.query(`TRUNCATE assistant_trajectories`);
});

/** Fake LLM client: returns a fixed distillation JSON (completeJson's first-round kind:'json' passes value/model through). */
function stubClient() {
  return {
    provider: 'openai' as const,
    complete: async () => ({
      kind: 'json' as const,
      value: { task_title: '登录失败提示任务', task_keywords: '登录 密码错误 提示', digest: '## 任务描述\n…\n## 环境事实\n…\n## 关键决策\n…\n## 最终用例形态\n…\n## verify 证据\n一次通过' },
      provider: 'openai' as const,
      vision: false,
      model: 'stub-model',
    }),
  };
}

describe('R2 trajectories：蒸馏 worker', () => {
  async function seedThreadWithFixture(opts: { verified: boolean }): Promise<{ threadId: string; caseId: string; lineId: string; sessionsRoot: string; versionId: string; projectId: string; sessionFile: string }> {
    const { projectId, versionId } = await seedProject(pool);
    const lineId = (await pool.query(`SELECT product_line_id FROM projects WHERE id=$1`, [projectId])).rows[0]!.product_line_id as string;
    const threadId = randomUUID();
    const piThreadId = `01atest-${randomUUID().slice(0, 8)}`;
    await pool.query(`INSERT INTO ai_threads (id, kind, version_id, pi_thread_id) VALUES ($1,'version',$2,$3)`, [threadId, versionId, piThreadId]);
    // Case + steps (the final shape fed into distillation)
    const gid = (await pool.query(`INSERT INTO "groups" (project_id, name) VALUES ($1,'G') RETURNING id`, [projectId])).rows[0]!.id;
    const caseId = (await pool.query(`INSERT INTO test_cases (group_id, version_id, title, expected_outcome) VALUES ($1,$2,'登录-密码错误',$3) RETURNING id`, [gid, versionId, '提示密码错误'])).rows[0]!.id;
    await pool.query(`INSERT INTO test_steps (case_id, "order", source, instruction) VALUES ($1,0,'ai','输入错误密码'),($1,1,'ai','点击登录')`, [caseId]);
    const callId = 'c1';
    // Production shape: verify_case's ordinary failures are also ok:true → isError:false; the evidence lives in the body JSON (C1).
    const verifyText = opts.verified
      ? JSON.stringify({ result: 'passed', basedOn: 'staged', caseId: 'loc-1', resumeFrom: 0, steps: [] })
      : JSON.stringify({ result: 'failed', basedOn: 'staged', caseId: 'loc-1', failure: { stepOrder: 1, error: '找不到元素' } });
    const jsonl = [
      JSON.stringify({ type: 'session', version: 3, id: piThreadId, timestamp: 'x', cwd: '/x' }),
      JSON.stringify({ type: 'message', id: 'm1', parentId: null, timestamp: 'x', message: { role: 'user', content: [{ type: 'text', text: '建一条登录失败提示用例' }] } }),
      JSON.stringify({ type: 'message', id: 'm2', parentId: 'm1', timestamp: 'x', message: { role: 'assistant', content: [
        { type: 'text', text: '先暂存再实测验证' },
        { type: 'toolCall', id: callId, name: 'verify_case', arguments: { caseId: 'loc-1' } },
      ] } }),
      JSON.stringify({ type: 'message', id: 'm3', parentId: 'm2', timestamp: 'x', message: { role: 'toolResult', toolCallId: callId, toolName: 'verify_case', isError: false, content: [{ type: 'text', text: verifyText }] } }),
    ].join('\n');
    const sessionsRoot = mkdtempSync(join(tmpdir(), 'traj-sessions-'));
    tmpRoots.push(sessionsRoot);
    writeFileSync(join(sessionsRoot, `2026-10-31T00-00-00-000Z_${piThreadId}.jsonl`), jsonl);
    return { threadId, caseId, lineId, sessionsRoot, versionId, projectId, sessionFile: join(sessionsRoot, `2026-10-31T00-00-00-000Z_${piThreadId}.jsonl`) };
  }

  it('判据满足：蒸馏入库（task_title/keywords/digest/distill_model/溯源列全）', async () => {
    const fx = await seedThreadWithFixture({ verified: true });
    const { processTrajectoryJob } = await import('../src/scheduler/trajectoryWorker.js');
    await processTrajectoryJob(
      { kind: 'trajectory', threadId: fx.threadId, versionId: fx.versionId, userId: null, items: [{ localId: 'loc-1', caseId: fx.caseId }] },
      { client: stubClient(), sessionsRoot: fx.sessionsRoot },
    );
    const row = (await pool.query(`SELECT * FROM assistant_trajectories`)).rows[0]!;
    expect(row.task_title).toBe('登录失败提示任务');
    expect(row.task_keywords).toBe('登录 密码错误 提示');
    expect(row.digest).toContain('verify 证据');
    expect(row.distill_model).toBe('stub-model');
    expect(row.source_case_id).toBe(fx.caseId);
    expect(row.product_line_id).toBe(fx.lineId);
    expect(row.case_title).toBe('登录-密码错误');
    expect(row.source_project_id).toBe(fx.projectId);
    expect(row.source_version_id).toBe(fx.versionId);
  });

  it('判据不满足（verify 失败）：不入库', async () => {
    const fx = await seedThreadWithFixture({ verified: false });
    const { processTrajectoryJob } = await import('../src/scheduler/trajectoryWorker.js');
    await processTrajectoryJob(
      { kind: 'trajectory', threadId: fx.threadId, versionId: fx.versionId, userId: null, items: [{ localId: 'loc-1', caseId: fx.caseId }] },
      { client: stubClient(), sessionsRoot: fx.sessionsRoot },
    );
    const n = (await pool.query(`SELECT count(*)::int n FROM assistant_trajectories`)).rows[0]!;
    expect(n.n).toBe(0);
  });

  it('会话文件缺失：静默跳过不抛', async () => {
    const fx = await seedThreadWithFixture({ verified: true });
    const emptyRoot = mkdtempSync(join(tmpdir(), 'traj-empty-'));
    tmpRoots.push(emptyRoot);
    const { processTrajectoryJob } = await import('../src/scheduler/trajectoryWorker.js');
    await expect(processTrajectoryJob(
      { kind: 'trajectory', threadId: fx.threadId, versionId: fx.versionId, userId: null, items: [{ localId: 'loc-1', caseId: fx.caseId }] },
      { client: stubClient(), sessionsRoot: emptyRoot },
    )).resolves.toBeUndefined();
  });

  it('pi_thread_id 为完整路径（生产 session.ts:849 形态）：仍能定位文件并蒸馏入库', async () => {
    const fx = await seedThreadWithFixture({ verified: true });
    // Production code writes the full sessionFile path, not a bare UUID — the fixture matches the real shape
    await pool.query(`UPDATE ai_threads SET pi_thread_id=$1 WHERE id=$2`, [fx.sessionFile, fx.threadId]);
    const { processTrajectoryJob } = await import('../src/scheduler/trajectoryWorker.js');
    await processTrajectoryJob(
      { kind: 'trajectory', threadId: fx.threadId, versionId: fx.versionId, userId: null, items: [{ localId: 'loc-1', caseId: fx.caseId }] },
      { client: stubClient(), sessionsRoot: fx.sessionsRoot },
    );
    const n = (await pool.query(`SELECT count(*)::int n FROM assistant_trajectories`)).rows[0]!;
    expect(n.n).toBe(1);
  });

  it('LLM 输出形状不合法：丢弃该 item 不入库、不抛', async () => {
    const fx = await seedThreadWithFixture({ verified: true });
    // completeJson semantically retries kind:'text' once; if it's still text it throws — the worker's per-item
    // try/catch catches it → discard. Both paths (throw / zod failure) share the same observable result: nothing persisted.
    const bad = { ...stubClient(), complete: async () => ({ kind: 'text' as const, value: 'not json', provider: 'openai' as const, vision: false, model: 'stub' }) };
    const { processTrajectoryJob } = await import('../src/scheduler/trajectoryWorker.js');
    await processTrajectoryJob(
      { kind: 'trajectory', threadId: fx.threadId, versionId: fx.versionId, userId: null, items: [{ localId: 'loc-1', caseId: fx.caseId }] },
      { client: bad, sessionsRoot: fx.sessionsRoot },
    );
    const n = (await pool.query(`SELECT count(*)::int n FROM assistant_trajectories`)).rows[0]!;
    expect(n.n).toBe(0);
  });

  it('LLM 蒸馏超时（complete 永不 resolve）：丢弃该 item 不入库、不抛', async () => {
    const fx = await seedThreadWithFixture({ verified: true });
    const hang = { ...stubClient(), complete: () => new Promise<never>(() => {}) };
    const { processTrajectoryJob } = await import('../src/scheduler/trajectoryWorker.js');
    await processTrajectoryJob(
      { kind: 'trajectory', threadId: fx.threadId, versionId: fx.versionId, userId: null, items: [{ localId: 'loc-1', caseId: fx.caseId }] },
      { client: hang, sessionsRoot: fx.sessionsRoot, llmTimeoutMs: 50 },
    );
    const n = (await pool.query(`SELECT count(*)::int n FROM assistant_trajectories`)).rows[0]!;
    expect(n.n).toBe(0);
  });
});
