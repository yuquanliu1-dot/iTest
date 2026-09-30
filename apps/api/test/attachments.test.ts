import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let pgContainer: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = pgContainer.getConnectionUri();
  process.env.UPLOAD_DIR = '/tmp/itest-uploads-' + Date.now();
  pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { casesRoute } = await import('../src/routes/cases.js');
  const { attachmentsRoute } = await import('../src/routes/attachments.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  // Raw body parser must be registered before the route that consumes it.
  app.use(express.raw({ type: 'application/octet-stream', limit: '60mb' }));
  app.use(express.json());
  app.use('/api/cases', casesRoute);
  app.use('/api/cases', attachmentsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await pgContainer.stop();
});

describe('attachments', () => {
  it('uploads file and returns sha256 + id', async () => {
    const { caseId } = await seedCase(pool);
    const buf = Buffer.from('hello world');
    const r = await request(app)
      .post(`/api/cases/${caseId}/attachments`)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Filename', 'hello.txt')
      .send(buf);
    expect(r.status).toBe(200);
    expect(r.body.sha256).toHaveLength(64);
    expect(r.body.originalName).toBe('hello.txt');
    expect(r.body.size).toBe(buf.length);
  });

  it('same content uploaded twice returns the same record', async () => {
    const { caseId } = await seedCase(pool);
    const buf = Buffer.from('dup-content');
    const r1 = await request(app).post(`/api/cases/${caseId}/attachments`).set('Content-Type', 'application/octet-stream').set('X-Filename', 'a.txt').send(buf);
    const r2 = await request(app).post(`/api/cases/${caseId}/attachments`).set('Content-Type', 'application/octet-stream').set('X-Filename', 'b.txt').send(buf);
    expect(r1.body.id).toBe(r2.body.id);
  });

  it('rejects oversize upload', async () => {
    const { caseId } = await seedCase(pool);
    process.env.UPLOAD_MAX_BYTES = '10';
    const buf = Buffer.alloc(64, 1);
    const r = await request(app).post(`/api/cases/${caseId}/attachments`).set('Content-Type', 'application/octet-stream').set('X-Filename', 'big.bin').send(buf);
    expect(r.status).toBe(413);
    process.env.UPLOAD_MAX_BYTES = undefined;
  });
});

async function seedCase(pool: Pool): Promise<{ caseId: string }> {
  const { projectId, groupId } = await seedProject(pool);
  const c = await pool.query(`INSERT INTO test_cases(group_id, title) VALUES ($1, 'C') RETURNING id`, [groupId]);
  return { caseId: c.rows[0]!.id as string };
}
