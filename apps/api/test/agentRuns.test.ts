import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

// mock llmSettings，让 case2script 测试不依赖真实 LLM provider；返回两条固定步骤
vi.mock('../src/agent/llmSettings.js', () => ({
  resolveLlmClient: async () => ({
    config: { provider: 'openai', apiKey: 'sk-test', model: 'gpt-test', baseUrl: 'http://x' },
    client: {
      provider: 'openai' as const,
      complete: async () => ({
        kind: 'json' as const,
        value: {
          steps: [
            { order: 0, action: { kind: 'navigate', url: 'https://example.com' } },
            { order: 1, action: { kind: 'click', locator: [{ strategy: 'css', value: '#btn' }] } },
          ],
        },
      }),
    },
  }),
}));

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
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(userId, username, orgId, orgPath);
    next();
  });
  app.use('/api/agent-runs', agentRunsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

describe('agent-runs (case2script only)', () => {
  it('POST creates a case2script run and returns id', async () => {
    const { projectId, groupId } = await seedProject(pool);
    const req = await pool.query(
      `INSERT INTO requirements(title, content, project_id) VALUES ('t','c',$1) RETURNING id`,
      [projectId],
    );
    const c = await pool.query(
      `INSERT INTO test_cases(requirement_id, title, group_id) VALUES ($1, '用例', $2) RETURNING id`,
      [req.rows[0]!.id, groupId],
    );
    const r = await request(app)
      .post('/api/agent-runs')
      .send({ targetType: 'case2script', targetId: c.rows[0]!.id, prompt: '用例: 登录' });
    expect(r.status).toBe(200);
    expect(r.body.id).toBeTruthy();
  });

  it('case2script run appends steps via saveSteps tool', async () => {
    const { projectId, groupId } = await seedProject(pool);
    const req = await pool.query(
      `INSERT INTO requirements(title, content, project_id) VALUES ('t','c',$1) RETURNING id`,
      [projectId],
    );
    const c = await pool.query(
      `INSERT INTO test_cases(requirement_id, title, group_id) VALUES ($1, '用例A', $2) RETURNING id`,
      [req.rows[0]!.id, groupId],
    );
    const created = await request(app)
      .post('/api/agent-runs')
      .send({ targetType: 'case2script', targetId: c.rows[0]!.id, prompt: '用例: 登录' });
    await new Promise((r) => setTimeout(r, 500));
    const detail = await request(app).get(`/api/agent-runs/${created.body.id}`);
    expect(detail.body.status).toBe('success');
    const steps = await pool.query(`SELECT * FROM test_steps WHERE case_id = $1`, [c.rows[0]!.id]);
    expect(steps.rows.length).toBeGreaterThan(0);
  });
});