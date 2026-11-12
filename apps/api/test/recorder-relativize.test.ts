import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedProject, seedOrg } from './helpers/db.js';

let pool: Pool;
let app: import('express').Express;
let getSession: typeof import('../src/recorder/ws.js').getSession;
let appendStep: typeof import('../src/recorder/ws.js').appendStep;
let relativizeUrl: typeof import('../src/lib/resolve-url.js').relativizeUrl;
let projectWebOrigins: typeof import('../src/lib/resolve-url.js').projectWebOrigins;
let projectId: string;
let groupId: string;
let versionId: string;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  // The recorder route chain (incl. db/client, assertCaseVisible) must be dynamically imported after DATABASE_URL points at the test container.
  // Unlike recorder-route.test.ts: orgs/users are NOT truncated — the middleware closure binds the beforeAll seeded org identity,
  // and seedProject reuses the same org (WeakMap cache) so project visibility checks can pass.
  const { default: express } = await import('express');
  const { recorderRoute } = await import('../src/routes/recorder.js');
  const { casesRoute } = await import('../src/routes/cases.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  ({ getSession, appendStep } = await import('../src/recorder/ws.js'));
  ({ relativizeUrl, projectWebOrigins } = await import('../src/lib/resolve-url.js'));
  app = express();
  app.use(express.json());
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(userId, username, orgId, orgPath);
    next();
  });
  app.use('/api/cases', casesRoute);
  app.use('/api/recorder', recorderRoute);
  app.use(errorHandler);
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
});

beforeEach(async () => {
  const s = await seedProject(pool);
  projectId = s.projectId;
  groupId = s.groupId;
  versionId = s.versionId;
});

/** Insert a default web service under the projectId project (null name = the unnamed default). */
const insertWebEnv = async (name: string | null, origin: { scheme: string; host: string; port?: number }) => {
  const e = await pool.query(
    `INSERT INTO test_environments(project_id, name, is_default) VALUES ($1, '默认环境', true) RETURNING id`,
    [projectId],
  );
  const envId = e.rows[0]!.id as string;
  const payload = { ...(name ? { name } : {}), scheme: origin.scheme, host: origin.host, ...(origin.port ? { port: origin.port } : {}) };
  await pool.query(
    `INSERT INTO environment_objects(environment_id, object_type, label, payload, is_default) VALUES ($1, 'web', '前端', $2::jsonb, true)`,
    [envId, JSON.stringify(payload)],
  );
  return envId;
};

/** Create a case + open a recording session, returning { caseId, session }. */
const openCaseSession = async (opts: { targetUrl?: string; title?: string } = {}) => {
  const c = await request(app).post('/api/cases').send({ title: opts.title ?? 'REL', groupId, versionId });
  expect(c.status).toBe(200);
  const s = await request(app).post('/api/recorder/sessions').send({ caseId: c.body.id, mode: 'fresh', ...(opts.targetUrl ? { targetUrl: opts.targetUrl } : {}) });
  expect(s.status).toBe(200);
  return { caseId: c.body.id as string, session: (await getSession(s.body.sessionId))! };
};

const finish = (sessionId: string) => request(app).post(`/api/recorder/sessions/${sessionId}/finish`);

const getCase = async (caseId: string) => (await pool.query(`SELECT url, web_service_ref FROM test_cases WHERE id = $1`, [caseId])).rows[0] as { url: string | null; web_service_ref: string | null };
const getSteps = async (caseId: string) =>
  (await pool.query(`SELECT "order", compiled FROM test_steps WHERE case_id = $1 ORDER BY "order"`, [caseId]))
    .rows as Array<{ order: number; compiled: Array<{ kind: string; url?: string }> }>;

describe('relativizeUrl 纯函数（来自 resolve-url）', () => {
  it('命中 origin 剥离 path，保留 query/hash 并返回 ref', () => {
    const m = new Map([['http://a.com:8080', 'frontend']]);
    expect(relativizeUrl('http://a.com:8080/admin/x?y=1#z', m)).toEqual({ path: '/admin/x?y=1#z', ref: 'frontend' });
    // Pure origin: WHATWG URL normalizes pathname to '/' (T5 implementation), not the '' the spec once assumed
    expect(relativizeUrl('http://a.com:8080', m)).toEqual({ path: '/', ref: 'frontend' });
  });

  it('未命中/非绝对返回 null', () => {
    const m = new Map([['http://a.com', 'web']]);
    expect(relativizeUrl('https://other.com/x', m)).toBeNull();
    expect(relativizeUrl('/already/rel', m)).toBeNull();
  });

  it('命中未命名默认服务返回 { path, ref: null }', () => {
    const m = new Map([['http://a.com:8080', null]]);
    expect(relativizeUrl('http://a.com:8080/home', m)).toEqual({ path: '/home', ref: null });
  });
});

describe('projectWebOrigins：未命名默认记 null，未命名非默认跳过', () => {
  it('命名服务→name；未命名默认→null；未命名非默认不在 map', async () => {
    await insertWebEnv('frontend', { scheme: 'http', host: 'a.com', port: 8080 });
    const e = await pool.query(
      `INSERT INTO test_environments(project_id, name, is_default) VALUES ($1, '备用环境', false) RETURNING id`,
      [projectId],
    );
    const envId = e.rows[0]!.id as string;
    await pool.query(
      `INSERT INTO environment_objects(environment_id, object_type, label, payload, is_default) VALUES
        ($1, 'web', '默认', '{"scheme":"https","host":"b.com"}', true),
        ($1, 'web', '旁路', '{"scheme":"http","host":"c.com","port":8000}', false)`,
      [envId],
    );
    const map = await projectWebOrigins(projectId);
    expect(map.get('http://a.com:8080')).toBe('frontend');
    expect(map.get('https://b.com')).toBeNull();
    expect(map.get('http://c.com:8000')).toBeUndefined();
  });
});

describe('recorder finish 落库尽力相对化', () => {
  it('初始导航（首步 url）命中环境 origin → 存相对路径 + 绑定服务', async () => {
    await insertWebEnv('frontend', { scheme: 'http', host: 'a.com', port: 8080 });
    const { caseId, session } = await openCaseSession();
    await appendStep(session.sessionId, { action: { kind: 'click', locator: [{ strategy: 'css', value: '#a' }] }, url: 'http://a.com:8080/admin/x?y=1#z' });
    expect((await finish(session.sessionId)).status).toBe(200);
    expect(await getCase(caseId)).toEqual({ url: '/admin/x?y=1#z', web_service_ref: 'frontend' });
  });

  it('targetUrl 命中 → 存相对 + 绑定；未命中（外站）保留绝对', async () => {
    await insertWebEnv('frontend', { scheme: 'http', host: 'a.com', port: 8080 });
    const hit = await openCaseSession({ targetUrl: 'http://a.com:8080/login' });
    expect((await finish(hit.session.sessionId)).status).toBe(200);
    expect(await getCase(hit.caseId)).toEqual({ url: '/login', web_service_ref: 'frontend' });

    const s2 = await seedProject(pool);
    const missCase = await request(app).post('/api/cases').send({ title: 'REL-MISS', groupId: s2.groupId, versionId: s2.versionId });
    const missSession = await request(app).post('/api/recorder/sessions').send({ caseId: missCase.body.id, mode: 'fresh', targetUrl: 'https://other.test/home' });
    expect((await finish(missSession.body.sessionId)).status).toBe(200);
    expect(await getCase(missCase.body.id)).toEqual({ url: 'https://other.test/home', web_service_ref: null });
  });

  it('纯 origin 命中 → url 存 / + 绑定服务（回放从服务根开始）', async () => {
    await insertWebEnv('frontend', { scheme: 'http', host: 'a.com', port: 8080 });
    const { caseId, session } = await openCaseSession({ targetUrl: 'http://a.com:8080' });
    expect((await finish(session.sessionId)).status).toBe(200);
    expect(await getCase(caseId)).toEqual({ url: '/', web_service_ref: 'frontend' });
  });

  it('中途 navigate 命中 → 剥成相对路径落库；外站 navigate 保留绝对', async () => {
    await insertWebEnv('frontend', { scheme: 'http', host: 'a.com', port: 8080 });
    const { caseId, session } = await openCaseSession();
    // First step navigate: action.url is the mid-run strip target; the top-level url is the initial-navigation source (same shape as extension reports)
    await appendStep(session.sessionId, { action: { kind: 'navigate', url: 'http://a.com:8080/setup?p=1' }, url: 'http://a.com:8080/setup?p=1' });
    await appendStep(session.sessionId, { action: { kind: 'click', locator: [{ strategy: 'css', value: '#a' }] }, url: 'http://a.com:8080/setup?p=1' });
    await appendStep(session.sessionId, { action: { kind: 'navigate', url: 'https://other.test/faq' } });
    expect((await finish(session.sessionId)).status).toBe(200);
    const steps = await getSteps(caseId);
    expect(steps[0]!.compiled[0]).toEqual({ kind: 'navigate', url: '/setup?p=1' });
    expect(steps[2]!.compiled[0]).toEqual({ kind: 'navigate', url: 'https://other.test/faq' });
    // Initial navigation takes the first step's url (hit) → case-level relative + binding
    expect(await getCase(caseId)).toEqual({ url: '/setup?p=1', web_service_ref: 'frontend' });
  });

  it('未命名默认服务命中 → 存相对 + ref 为 null', async () => {
    await insertWebEnv(null, { scheme: 'http', host: 'a.com', port: 8080 });
    const { caseId, session } = await openCaseSession();
    await appendStep(session.sessionId, { action: { kind: 'click', locator: [{ strategy: 'css', value: '#a' }] }, url: 'http://a.com:8080/home' });
    expect((await finish(session.sessionId)).status).toBe(200);
    expect(await getCase(caseId)).toEqual({ url: '/home', web_service_ref: null });
  });

  it('已有 case.url 不覆盖（即使命中 origin）', async () => {
    await insertWebEnv('frontend', { scheme: 'http', host: 'a.com', port: 8080 });
    const c = await request(app).post('/api/cases').send({ title: 'REL-PINNED', url: 'http://a.com:8080/pinned', groupId, versionId });
    const s = await request(app).post('/api/recorder/sessions').send({ caseId: c.body.id, mode: 'append', targetUrl: 'http://a.com:8080/should-not-win' });
    const session = (await getSession(s.body.sessionId))!;
    await appendStep(session.sessionId, { action: { kind: 'click', locator: [{ strategy: 'css', value: '#a' }] }, url: 'http://a.com:8080/pinned' });
    expect((await finish(session.sessionId)).status).toBe(200);
    expect(await getCase(c.body.id)).toEqual({ url: 'http://a.com:8080/pinned', web_service_ref: null });
  });
});