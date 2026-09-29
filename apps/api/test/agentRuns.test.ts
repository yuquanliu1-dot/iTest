import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(`
    CREATE TABLE requirements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title varchar(200) NOT NULL, content text NOT NULL, status varchar(20) NOT NULL DEFAULT 'draft', created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
    CREATE TABLE test_cases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), requirement_id uuid REFERENCES requirements(id) ON DELETE CASCADE, title varchar(200) NOT NULL, description text, priority varchar(20) NOT NULL DEFAULT 'P1', status varchar(20) NOT NULL DEFAULT 'draft', created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
    CREATE TABLE test_steps (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), case_id uuid REFERENCES test_cases(id) ON DELETE CASCADE NOT NULL, "order" integer NOT NULL, source varchar(20) NOT NULL, action jsonb NOT NULL, assertion jsonb, created_at timestamp NOT NULL DEFAULT now());
    CREATE TABLE agent_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), target_type varchar(30) NOT NULL, target_id uuid NOT NULL, status varchar(20) NOT NULL, prompt text NOT NULL, result jsonb, error text, started_at timestamp NOT NULL DEFAULT now(), finished_at timestamp);
  `);
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
    const req = await pool.query(`INSERT INTO requirements(title, content) VALUES ('t','c') RETURNING id`);
    const r = await request(app)
      .post('/api/agent-runs')
      .send({ targetType: 'requirement2cases', targetId: req.rows[0].id, prompt: 't' });
    expect(r.status).toBe(200);
    expect(r.body.id).toBeTruthy();
  });

  it('GET /:id returns detail after finish', async () => {
    const r0 = await pool.query(`INSERT INTO requirements(title, content) VALUES ('x','y') RETURNING id`);
    const created = await request(app)
      .post('/api/agent-runs')
      .send({ targetType: 'requirement2cases', targetId: r0.rows[0].id, prompt: 'requirement: p' });
    await new Promise((r) => setTimeout(r, 500));
    const detail = await request(app).get(`/api/agent-runs/${created.body.id}`);
    expect(detail.body.status).toBe('success');
  });
});
