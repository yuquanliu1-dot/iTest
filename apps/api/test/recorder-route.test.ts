import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

// finish 对 sensitive fill 走 AES-256-GCM 加密，独立跑本文件时无其它用例注入该键
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 1).toString('base64');

let pg: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;
let appendStep: typeof import('../src/recorder/ws.js').appendStep;

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = pg.getConnectionUri();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { recorderRoute } = await import('../src/routes/recorder.js');
  const { casesRoute } = await import('../src/routes/cases.js');
  const { stepsRoute } = await import('../src/routes/steps.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  ({ appendStep } = await import('../src/recorder/ws.js'));
  app = express();
  app.use(express.json());
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  // 注入种子组织管理员身份（跳过真实登录；可见性判定依赖 managerOrgPaths 子树）。
  // helpers/auth 依赖 src 服务链（连带加载 db client），须等 DATABASE_URL 指向测试容器后再动态加载。
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(userId, username, orgId, orgPath);
    next();
  });
  app.use('/api/cases', casesRoute);
  app.use('/api/cases', stepsRoute);
  app.use('/api/recorder', recorderRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await pg.stop();
});

describe('recorder routes', () => {
  it('POST /api/recorder/sessions accepts mode/incognito/resumeFromOrder', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'R', groupId, versionId });
    const r = await request(app).post('/api/recorder/sessions').send({
      caseId: c.body.id,
      mode: 'incognito',
      incognito: true,
      resumeFromOrder: 3,
    });
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe('incognito');
  });

  it('resume with unbound upload step in the prefix returns 409', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'RU', groupId, versionId });
    await request(app).put(`/api/cases/${c.body.id}/steps`).send({
      steps: [
        {
          compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#x' }] }],
          source: 'manual',
        },
        {
          compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#y' }] }],
          source: 'manual',
        },
      ],
    });
    // Force step #1 into an upload step with no fileId (bypassing PUT validation)
    await pool.query(
      `UPDATE test_steps SET compiled = $1::jsonb WHERE case_id = $2 AND "order" = 1`,
      [JSON.stringify([{ kind: 'upload', locator: [{ strategy: 'css', value: 'input[type=file]' }] }]), c.body.id],
    );
    // resumeFromOrder = 2 → prefix is step #1 (unbound upload) → 409
    const r = await request(app).post('/api/recorder/sessions').send({
      caseId: c.body.id,
      mode: 'resume',
      resumeFromOrder: 2,
    });
    expect(r.status).toBe(409);
  });

  it('resume boundary step itself is not validated', async () => {    const { groupId, versionId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'RB', groupId, versionId });
    await request(app).put(`/api/cases/${c.body.id}/steps`).send({
      steps: [
        {
          compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#x' }] }],
          source: 'manual',
        },
      ],
    });
    // Step #1 is an unbound upload, but resume starts AT it (resumeFromOrder = 1),
    // so the prefix is empty and creation must succeed.
    await pool.query(
      `UPDATE test_steps SET compiled = $1::jsonb WHERE case_id = $2 AND "order" = 1`,
      [JSON.stringify([{ kind: 'upload', locator: [{ strategy: 'css', value: 'input[type=file]' }] }]), c.body.id],
    );
    const r = await request(app).post('/api/recorder/sessions').send({
      caseId: c.body.id,
      mode: 'resume',
      resumeFromOrder: 1,
    });
    expect(r.status).toBe(200);
  });

  it('finish writes test_cases.url from first step url for a fresh recording', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'NV', groupId, versionId });
    const s = await request(app).post('/api/recorder/sessions').send({ caseId: c.body.id, mode: 'fresh' });
    await appendStep(s.body.sessionId, { action: { kind: 'click', locator: [{ strategy: 'css', value: '#a' }] }, url: 'https://app.example.com/home' });
    await appendStep(s.body.sessionId, { action: { kind: 'fill', locator: [{ strategy: 'css', value: '#b' }], value: 'x' }, url: 'https://app.example.com/home' });
    const f = await request(app).post(`/api/recorder/sessions/${s.body.sessionId}/finish`);
    expect(f.status).toBe(200);
    expect(f.body.inserted).toBe(2);
    const rows = await pool.query(
      `SELECT "order", compiled FROM test_steps WHERE case_id = $1 ORDER BY "order"`,
      [c.body.id],
    );
    // 不再落 navigate 步骤：首步是 click，初始导航写到 test_cases.url
    expect((rows.rows[0]!.compiled as Array<{ kind: string }>)[0]!.kind).toBe('click');
    const tcRows = await pool.query(`SELECT url FROM test_cases WHERE id = $1`, [c.body.id]);
    expect(tcRows.rows[0]!.url).toBe('https://app.example.com/home');
  });

  it('finish merges consecutive fills on the same locator, keeping the last value', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'MF', groupId, versionId });
    const s = await request(app).post('/api/recorder/sessions').send({ caseId: c.body.id, mode: 'fresh' });
    const locator = [{ strategy: 'css', value: '#auth-password' }];
    // React input remount / 中途停顿产生的碎片 fill（值为累计值）
    await appendStep(s.body.sessionId, { action: { kind: 'click', locator: [{ strategy: 'css', value: '#auth-username' }] }, url: 'https://app.example.com/' });
    await appendStep(s.body.sessionId, { action: { kind: 'fill', locator, value: 'a', sensitive: true }, url: 'https://app.example.com/' });
    await appendStep(s.body.sessionId, { action: { kind: 'fill', locator, value: 'admin', sensitive: true }, url: 'https://app.example.com/' });
    await appendStep(s.body.sessionId, { action: { kind: 'fill', locator, value: 'admin123', sensitive: true }, url: 'https://app.example.com/' });
    // 中间夹了别的步骤 → 不合并
    await appendStep(s.body.sessionId, { action: { kind: 'click', locator: [{ strategy: 'css', value: '#submit' }] }, url: 'https://app.example.com/' });
    await appendStep(s.body.sessionId, { action: { kind: 'fill', locator, value: 'changed' }, url: 'https://app.example.com/' });
    const f = await request(app).post(`/api/recorder/sessions/${s.body.sessionId}/finish`);
    expect(f.status).toBe(200);
    expect(f.body.inserted).toBe(4);
    const rows = await pool.query(
      `SELECT "order", compiled, secret_ciphertext, secret_iv, secret_tag FROM test_steps WHERE case_id = $1 ORDER BY "order"`,
      [c.body.id],
    );
    const kinds = rows.rows.map((r: { compiled: Array<{ kind: string; value?: string }> }) => r.compiled[0]);
    expect(kinds.map((a: { kind: string }) => a.kind)).toEqual(['click', 'fill', 'click', 'fill']);
    // sensitive fill：明文不进 compiled(value 已加密),compiled 仅标记 sensitive=true
    expect((kinds[1] as { value?: string }).value).toBeUndefined();
    expect((kinds[1]! as { sensitive?: boolean }).sensitive).toBe(true);
    expect(kinds[3]!.value).toBe('changed');
    // 明文落 secret_ciphertext（AES-256-GCM 三元组），解密回 'admin123'
    const { decrypt } = await import('../src/lib/secret-crypto.js');
    const merged = rows.rows[1] as { compiled: Array<{ kind: string }>; secret_iv: string; secret_tag: string; secret_ciphertext: string };
    expect(merged.compiled[0]!.kind).toBe('fill');
    expect(decrypt({ ciphertext: Buffer.from(merged.secret_ciphertext, 'base64'), iv: Buffer.from(merged.secret_iv, 'base64'), tag: Buffer.from(merged.secret_tag, 'base64') })).toBe('admin123');
  });

  it('finish falls back to default env web origin when steps carry no url', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    const e = await pool.query(`INSERT INTO test_environments(project_id, name, is_default) VALUES ($1, '默认', true) RETURNING id`, [projectId]);
    await pool.query(`INSERT INTO environment_objects(environment_id, object_type, label, payload, is_default) VALUES ($1,'web','默认 Web','{"name":"web","scheme":"https","host":"prod.example.com"}',true)`, [e.rows[0]!.id]);
    const c = await request(app).post('/api/cases').send({ title: 'NVD', groupId, versionId });
    const s = await request(app).post('/api/recorder/sessions').send({ caseId: c.body.id, mode: 'incognito' });
    await appendStep(s.body.sessionId, { action: { kind: 'click', locator: [{ strategy: 'css', value: '#a' }] } });
    const f = await request(app).post(`/api/recorder/sessions/${s.body.sessionId}/finish`);
    expect(f.status).toBe(200);
    const tcRows = await pool.query(`SELECT url, web_service_ref FROM test_cases WHERE id = $1`, [c.body.id]);
    // 兜底 origin 命中命名默认 web 服务对象(name=web) → 相对化 '/' + web_service_ref='web'
    expect(tcRows.rows[0]!.url).toBe('/');
    expect(tcRows.rows[0]!.web_service_ref).toBe('web');
    const stepRows = await pool.query(
      `SELECT compiled FROM test_steps WHERE case_id = $1 ORDER BY "order"`,
      [c.body.id],
    );
    expect(stepRows.rows.filter((r: { compiled: Array<{ kind: string }> }) => r.compiled[0]?.kind === 'navigate')).toHaveLength(0);
  });

  it('finish does not overwrite existing case.url on append', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'NVA', url: 'https://pinned.example.com', groupId, versionId });
    await request(app).put(`/api/cases/${c.body.id}/steps`).send({
      steps: [{ compiled: [{ kind: 'navigate', url: 'https://app.example.com' }], source: 'manual' }],
    });
    const s = await request(app).post('/api/recorder/sessions').send({ caseId: c.body.id, mode: 'append' });
    await appendStep(s.body.sessionId, { action: { kind: 'click', locator: [{ strategy: 'css', value: '#a' }] }, url: 'https://app.example.com/home' });
    const f = await request(app).post(`/api/recorder/sessions/${s.body.sessionId}/finish`);
    expect(f.status).toBe(200);
    expect(f.body.inserted).toBe(1);
    const tcRows = await pool.query(`SELECT url FROM test_cases WHERE id = $1`, [c.body.id]);
    expect(tcRows.rows[0]!.url).toBe('https://pinned.example.com');
    const stepRows = await pool.query(
      `SELECT compiled FROM test_steps WHERE case_id = $1 ORDER BY "order"`,
      [c.body.id],
    );
    expect(stepRows.rows).toHaveLength(2);
    expect((stepRows.rows[1]!.compiled as Array<{ kind: string }>)[0]!.kind).toBe('click');
  });

  it('finish writes session.targetUrl to test_cases.url when steps have no url', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'NVN', groupId, versionId });
    const s = await request(app).post('/api/recorder/sessions').send({
      caseId: c.body.id,
      mode: 'fresh',
      targetUrl: 'https://web-passed.example.com',
    });
    await appendStep(s.body.sessionId, { action: { kind: 'click', locator: [{ strategy: 'css', value: '#a' }] } });
    const f = await request(app).post(`/api/recorder/sessions/${s.body.sessionId}/finish`);
    expect(f.status).toBe(200);
    expect(f.body.inserted).toBe(1);
    const tcRows = await pool.query(`SELECT url FROM test_cases WHERE id = $1`, [c.body.id]);
    expect(tcRows.rows[0]!.url).toBe('https://web-passed.example.com');
  });

  it('relative url + no default env → 422 with actionable message（不再静默 null 让扩展打开 file 错误页）', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    // 环境与 web 服务都在,但环境没设默认 → displayWebEnv 返回 null → resolveCaseUrl 只回 null
    const e = await pool.query(
      `INSERT INTO test_environments(project_id, name, is_default) VALUES ($1, '测试环境', false) RETURNING id`,
      [projectId],
    );
    await pool.query(
      `INSERT INTO environment_objects(environment_id, object_type, label, payload, is_default)
       VALUES ($1,'web','默认 Web','{"name":"web","scheme":"http","host":"110.example.com","port":9400}',true)`,
      [e.rows[0]!.id],
    );
    const c = await request(app).post('/api/cases').send({ title: 'RU', url: '/index', groupId, versionId });
    const r = await request(app).post('/api/recorder/sessions').send({ caseId: c.body.id, mode: 'fresh' });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('url_unresolved');
    expect(r.body.message).toContain('/index');
    expect(r.body.message).toContain('默认环境');
  });

  it('relative url + default env without web service → 422 web_service_missing（WebServiceMissing 不再 500）', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    await pool.query(`INSERT INTO test_environments(project_id, name, is_default) VALUES ($1, '默认', true)`, [projectId]);
    const c = await request(app).post('/api/cases').send({ title: 'RU2', url: '/x', groupId, versionId });
    const r = await request(app).post('/api/recorder/sessions').send({ caseId: c.body.id, mode: 'fresh' });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('web_service_missing');
  });

  it('empty url + no env 仍 200 resolvedUrl=null（about:blank 起录现状保留）', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'RU3', groupId, versionId });
    const r = await request(app).post('/api/recorder/sessions').send({ caseId: c.body.id, mode: 'fresh' });
    expect(r.status).toBe(200);
    expect(r.body.resolvedUrl).toBeNull();
  });
});