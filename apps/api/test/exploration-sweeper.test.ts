/**
 * 探索会话看门狗：把「执行器已死、状态却还停在 running」的僵死会话判死。
 *
 * 判据 = 心跳超时（heartbeat_at）。真源：发版重建 api 容器 → 执行器进程被杀 →
 * exec worker 的 catch 只写日志不写状态 → 会话永远 running → 删除永远 409。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let pool: Pool;
let projectId: string;
let versionId: string;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  const seeded = await seedProject(pool);
  projectId = seeded.projectId;
  versionId = seeded.versionId;
  await import('../src/db/client.js');
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
});

/** 建一条会话（心跳时刻可指定；null = 从未心跳）。 */
async function insertSession(heartbeatAt: Date | null, status = 'running'): Promise<string> {
  const r = await pool.query(
    `INSERT INTO exploration_sessions(project_id, version_id, title, charter, persona, status, heartbeat_at)
     VALUES ($1,$2,'会话','章程','qa',$3,$4) RETURNING id`,
    [projectId, versionId, status, heartbeatAt],
  );
  return r.rows[0]!.id as string;
}

describe('探索会话看门狗', () => {
  it('心跳超时（且无心跳）的 running 会话 → 判死 failed + 给出可重跑的原因', async () => {
    const { sweepStaleExplorations } = await import('../src/scheduler/explorationSweeper.js');
    const stale = await insertSession(null);
    const old = await insertSession(new Date(Date.now() - 10 * 60_000));

    const n = await sweepStaleExplorations();
    expect(n).toBeGreaterThanOrEqual(2);

    for (const id of [stale, old]) {
      const row = (await pool.query(
        `SELECT status, error, finished_at FROM exploration_sessions WHERE id=$1`,
        [id],
      )).rows[0]!;
      expect(row.status).toBe('failed');
      expect(String(row.error)).toContain('心跳超时');
      expect(row.finished_at).toBeTruthy();
    }
  });

  it('心跳新鲜的 running 会话不动（不误杀活会话）', async () => {
    const { sweepStaleExplorations } = await import('../src/scheduler/explorationSweeper.js');
    const fresh = await insertSession(new Date());

    await sweepStaleExplorations();

    const row = (await pool.query(`SELECT status FROM exploration_sessions WHERE id=$1`, [fresh])).rows[0]!;
    expect(row.status).toBe('running');
  });

  it('非 running 状态不判死（终态会话不被动）', async () => {
    const { sweepStaleExplorations } = await import('../src/scheduler/explorationSweeper.js');
    const completed = await insertSession(null, 'completed');
    const cancelled = await insertSession(null, 'cancelled');

    await sweepStaleExplorations();

    for (const id of [completed, cancelled]) {
      const row = (await pool.query(`SELECT status FROM exploration_sessions WHERE id=$1`, [id])).rows[0]!;
      expect(row.status).not.toBe('failed');
    }
  });

  it('判死后可删（DELETE 不再 409）——僵死会话不再卡住用户', async () => {
    const { sweepStaleExplorations } = await import('../src/scheduler/explorationSweeper.js');
    const id = await insertSession(null);
    await sweepStaleExplorations();
    const row = (await pool.query(`SELECT status FROM exploration_sessions WHERE id=$1`, [id])).rows[0]!;
    expect(row.status).toBe('failed');
    // 路由层的删除守卫只看 status running/pending + 未请求取消 → 判死后可删
    const del = await pool.query(`DELETE FROM exploration_sessions WHERE id=$1`, [id]);
    expect(del.rowCount).toBe(1);
  });
});
