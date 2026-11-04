import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let pool: Pool;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
});

afterAll(async () => {
  await pool.end();
});

describe('ai_threads', () => {
  it('ai_threads has unique requirementId', async () => {
    const { projectId } = await seedProject(pool);
    const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    const rid = r.rows[0]!.id as string;
    await pool.query(`INSERT INTO ai_threads(id, requirement_id, pi_thread_id) VALUES (gen_random_uuid(), $1, 'p1')`, [rid]);
    await expect(
      pool.query(`INSERT INTO ai_threads(id, requirement_id, pi_thread_id) VALUES (gen_random_uuid(), $1, 'p2')`, [rid]),
    ).rejects.toThrow();
  });

  it('cascade deletes when requirement is deleted', async () => {
    const { projectId } = await seedProject(pool);
    const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    const rid = r.rows[0]!.id as string;
    await pool.query(`INSERT INTO ai_threads(id, requirement_id, pi_thread_id) VALUES (gen_random_uuid(), $1, 'p')`, [rid]);
    await pool.query(`DELETE FROM requirements WHERE id = $1`, [rid]);
    const t = await pool.query(`SELECT count(*)::int AS n FROM ai_threads WHERE requirement_id = $1`, [rid]);
    expect(t.rows[0]!.n).toBe(0);
  });
});
