import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

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

describe('scenarios', () => {
  it('creates a scenario linked to a requirement', async () => {
    const { projectId } = await seedProject(pool);
    const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    const s = await pool.query(
      `INSERT INTO scenarios(requirement_id, title, description, "order") VALUES ($1,'S1','desc',0) RETURNING id`,
      [r.rows[0]!.id],
    );
    expect(s.rows[0]!.id).toBeTruthy();
  });

  it('test_cases.scenario_id ON DELETE SET NULL works', async () => {
    const { projectId, groupId } = await seedProject(pool);
    const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    const s = await pool.query(`INSERT INTO scenarios(requirement_id, title) VALUES ($1,'S') RETURNING id`, [r.rows[0]!.id]);
    const c = await pool.query(
      `INSERT INTO test_cases(requirement_id, group_id, title, scenario_id) VALUES ($1,$2,'case',$3) RETURNING id`,
      [r.rows[0]!.id, groupId, s.rows[0]!.id],
    );
    await pool.query(`DELETE FROM scenarios WHERE id = $1`, [s.rows[0]!.id]);
    const after = await pool.query(`SELECT scenario_id FROM test_cases WHERE id = $1`, [c.rows[0]!.id]);
    expect(after.rows[0]!.scenario_id).toBeNull();
  });

  it('cascade deletes scenarios when requirement is deleted', async () => {
    const { projectId } = await seedProject(pool);
    const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    await pool.query(`INSERT INTO scenarios(requirement_id, title) VALUES ($1,'S')`, [r.rows[0]!.id]);
    await pool.query(`DELETE FROM requirements WHERE id = $1`, [r.rows[0]!.id]);
    const after = await pool.query(`SELECT count(*)::int AS n FROM scenarios WHERE requirement_id = $1`, [r.rows[0]!.id]);
    expect(after.rows[0]!.n).toBe(0);
  });
});