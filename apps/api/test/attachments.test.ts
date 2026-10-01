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
  it('uploads file and returns sha256 + id + createdAt + mime', async () => {
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
    expect(typeof r.body.createdAt).toBe('string');
    expect(r.body.mime).toBe('application/octet-stream');
  });

  it('same content in same project returns the same record', async () => {
    const { caseId } = await seedCase(pool);
    const buf = Buffer.from('dup-content');
    const r1 = await request(app).post(`/api/cases/${caseId}/attachments`).set('Content-Type', 'application/octet-stream').set('X-Filename', 'a.txt').send(buf);
    const r2 = await request(app).post(`/api/cases/${caseId}/attachments`).set('Content-Type', 'application/octet-stream').set('X-Filename', 'b.txt').send(buf);
    expect(r1.body.id).toBe(r2.body.id);
  });

  it('same content in different projects yields distinct records', async () => {
    const { caseId: c1 } = await seedCase(pool);
    const { caseId: c2 } = await seedCase(pool);
    const buf = Buffer.from('shared-content');
    const r1 = await request(app).post(`/api/cases/${c1}/attachments`).set('Content-Type', 'application/octet-stream').set('X-Filename', 'a.txt').send(buf);
    const r2 = await request(app).post(`/api/cases/${c2}/attachments`).set('Content-Type', 'application/octet-stream').set('X-Filename', 'a.txt').send(buf);
    expect(r1.body.sha256).toBe(r2.body.sha256);
    expect(r1.body.id).not.toBe(r2.body.id);
  });

  it('rejects oversize upload at the new 10 MB default', async () => {
    const { caseId } = await seedCase(pool);
    // 11 MB buffer
    const buf = Buffer.alloc(11 * 1024 * 1024, 1);
    const r = await request(app).post(`/api/cases/${caseId}/attachments`).set('Content-Type', 'application/octet-stream').set('X-Filename', 'big.bin').send(buf);
    expect(r.status).toBe(413);
  });

  it('GET /cases/:id/attachments lists project attachments with current case first', async () => {
    const { projectId, groupId, caseId } = await seedCase(pool);
    const buf = Buffer.from('first');
    await request(app).post(`/api/cases/${caseId}/attachments`).set('Content-Type', 'application/octet-stream').set('X-Filename', 'first.txt').send(buf);
    const otherCase = await pool.query(`INSERT INTO test_cases(group_id, title) VALUES ($1, 'Other') RETURNING id`, [groupId]);
    await request(app).post(`/api/cases/${otherCase.rows[0]!.id}/attachments`).set('Content-Type', 'application/octet-stream').set('X-Filename', 'second.txt').send(Buffer.from('second'));
    const list = await request(app).get(`/api/cases/${caseId}/attachments`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(2);
    expect(list.body[0].originalName).toBe('first.txt');
    expect(list.body[1].originalName).toBe('second.txt');
    expect(typeof list.body[0].createdAt).toBe('string');
    expect(list.body[0].sha256).toHaveLength(64);
    // projectId is not in the row body (cleaned up)
    expect(list.body[0].caseId).toBeUndefined();
  });

  it('GET /cases/:id/attachments 404 on missing case', async () => {
    const r = await request(app).get(`/api/cases/${'00000000-0000-0000-0000-000000000000'}/attachments`);
    expect(r.status).toBe(404);
  });

  it('GET /cases/:id/attachments does not leak attachments from another project', async () => {
    const { caseId: caseA } = await seedCase(pool);
    const { caseId: caseB } = await seedCase(pool);
    await request(app).post(`/api/cases/${caseA}/attachments`).set('Content-Type', 'application/octet-stream').set('X-Filename', 'a.txt').send(Buffer.from('a'));
    await request(app).post(`/api/cases/${caseB}/attachments`).set('Content-Type', 'application/octet-stream').set('X-Filename', 'b.txt').send(Buffer.from('b'));
    const list = await request(app).get(`/api/cases/${caseA}/attachments`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].originalName).toBe('a.txt');
  });
});

async function seedCase(pool: Pool): Promise<{ projectId: string; groupId: string; caseId: string }> {
  const { projectId, groupId } = await seedProject(pool);
  const c = await pool.query(`INSERT INTO test_cases(group_id, title) VALUES ($1, 'C') RETURNING id`, [groupId]);
  return { projectId, groupId, caseId: c.rows[0]!.id as string };
}