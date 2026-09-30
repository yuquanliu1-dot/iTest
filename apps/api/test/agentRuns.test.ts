import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { agentRunsRoute } = await import('../src/routes/agentRuns.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  app.use('/api/agent-runs', agentRunsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

describe('agent-runs', () => {
  it('POST creates run and returns id', async () => {
    const { projectId } = await seedProject(pool);
    const req = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('t','c',$1) RETURNING id`, [projectId]);
    const r = await request(app)
      .post('/api/agent-runs')
      .send({ targetType: 'requirement2cases', targetId: req.rows[0].id, prompt: 't' });
    expect(r.status).toBe(200);
    expect(r.body.id).toBeTruthy();
  });

  it('GET /:id returns detail after finish', async () => {
    const { projectId, groupId } = await seedProject(pool);
    const r0 = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('x','y',$1) RETURNING id`, [projectId]);
    const created = await request(app)
      .post('/api/agent-runs')
      .send({ targetType: 'requirement2cases', targetId: r0.rows[0].id, prompt: 'requirement: p', targetGroupId: groupId });
    await new Promise((r) => setTimeout(r, 500));
    const detail = await request(app).get(`/api/agent-runs/${created.body.id}`);
    expect(detail.body.status).toBe('success');
  });

  it('requirement2cases run persists cases + steps via saveCase tool', async () => {
    const { projectId, groupId } = await seedProject(pool);
    const r0 = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('persist','req',$1) RETURNING id`, [projectId]);
    const created = await request(app)
      .post('/api/agent-runs')
      .send({ targetType: 'requirement2cases', targetId: r0.rows[0].id, prompt: 'requirement: login', targetGroupId: groupId });
    await new Promise((r) => setTimeout(r, 500));
    const detail = await request(app).get(`/api/agent-runs/${created.body.id}`);
    expect(detail.body.status).toBe('success');
    const cases = await pool.query(`SELECT * FROM test_cases WHERE requirement_id = $1`, [r0.rows[0].id]);
    expect(cases.rows.length).toBeGreaterThan(0);
    expect(cases.rows[0]!.group_id).toBe(groupId);
    const steps = await pool.query(`SELECT * FROM test_steps WHERE case_id = $1`, [cases.rows[0]!.id]);
    expect(steps.rows.length).toBeGreaterThan(0);
  });

  it('requirement2cases without targetGroupId fails with clear error', async () => {
    const { projectId } = await seedProject(pool);
    const r0 = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('nog','req',$1) RETURNING id`, [projectId]);
    const created = await request(app)
      .post('/api/agent-runs')
      .send({ targetType: 'requirement2cases', targetId: r0.rows[0].id, prompt: 'requirement: x' });
    await new Promise((r) => setTimeout(r, 500));
    const detail = await request(app).get(`/api/agent-runs/${created.body.id}`);
    expect(detail.body.status).toBe('failed');
    expect(detail.body.error).toMatch(/group/i);
  });

  it('case2script run appends steps via saveSteps tool', async () => {
    const { projectId, groupId } = await seedProject(pool);
    const c = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('s','t',$1) RETURNING id`, [projectId]);
    const tc = await pool.query(`INSERT INTO test_cases(requirement_id, title, group_id) VALUES ($1, '用例A', $2) RETURNING id`, [c.rows[0]!.id, groupId]);
    const created = await request(app)
      .post('/api/agent-runs')
      .send({ targetType: 'case2script', targetId: tc.rows[0]!.id, prompt: '用例: 登录' });
    await new Promise((r) => setTimeout(r, 500));
    const detail = await request(app).get(`/api/agent-runs/${created.body.id}`);
    expect(detail.body.status).toBe('success');
    const steps = await pool.query(`SELECT * FROM test_steps WHERE case_id = $1`, [tc.rows[0]!.id]);
    expect(steps.rows.length).toBeGreaterThan(0);
  });
});
