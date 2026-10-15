import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
});

afterAll(async () => {
  await pool.end();
  await container.stop();
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
