import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject, seedProjectInOrg } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;
let projectId: string;
let groupId: string;
let versionId: string;
let userId: string;
let username: string;
let orgId: string;
let orgPath: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'nqh12UCAW+ZhepC+gqL/n1phEn5mo+xq82Key67ePXI=';
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const seed = await seedProject(pool);
  projectId = seed.projectId;
  groupId = seed.groupId;
  versionId = seed.versionId;
  userId = seed.userId;
  username = seed.username;
  orgId = seed.orgId;
  orgPath = seed.orgPath;
  const { default: express } = await import('express');
  const { deviceTargetsRoute } = await import('../src/routes/deviceTargets.js');
  const { casesRoute } = await import('../src/routes/cases.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(userId, username, orgId, orgPath);
    next();
  });
  app.use('/api', deviceTargetsRoute);
  app.use('/api/cases', casesRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

async function newCase(title: string): Promise<string> {
  const r = await pool.query(
    `INSERT INTO test_cases(group_id, version_id, title) VALUES ($1, $2, $3) RETURNING id`,
    [groupId, versionId, title],
  );
  return r.rows[0]!.id as string;
}

describe('deviceTargets.service', () => {
  it('createDeviceTarget + listDeviceTargets roundtrip', async () => {
    const svc = await import('../src/services/deviceTargets.service.js');
    const created = await svc.createDeviceTarget(projectId, {
      name: 'svc-1',
      mobileOs: 'ios',
      deviceRef: 'iPhone 17 Pro',
    });
    expect(created.id).toBeTruthy();
    expect(created.name).toBe('svc-1');
    const list = await svc.listDeviceTargets(projectId);
    expect(list.find((t) => t.id === created.id)).toBeTruthy();
  });

  it('createDeviceTarget duplicate name → HttpError 409 name_conflict', async () => {
    const svc = await import('../src/services/deviceTargets.service.js');
    await svc.createDeviceTarget(projectId, { name: 'dup-name', mobileOs: 'android', deviceRef: 'Pixel 9' });
    const e = await svc
      .createDeviceTarget(projectId, { name: 'dup-name', mobileOs: 'android', deviceRef: 'Pixel 9' })
      .catch((err: unknown) => err);
    const { HttpError } = await import('../src/middleware/errorHandler.js');
    expect(e).toBeInstanceOf(HttpError);
    expect((e as { status?: number }).status).toBe(409);
    expect((e as { code?: string }).code).toBe('name_conflict');
  });

  it('updateDeviceTarget updates fields + advances updatedAt', async () => {
    const svc = await import('../src/services/deviceTargets.service.js');
    const created = await svc.createDeviceTarget(projectId, {
      name: 'upd-1',
      mobileOs: 'ios',
      deviceRef: 'iPhone 15',
    });
    // wait a tick so updatedAt differs
    await new Promise((r) => setTimeout(r, 5));
    const updated = await svc.updateDeviceTarget(created.id, {
      name: 'upd-1-renamed',
      mobileOs: 'android',
      deviceRef: 'Pixel 8',
    });
    expect(updated.name).toBe('upd-1-renamed');
    expect(updated.mobileOs).toBe('android');
    expect(updated.deviceRef).toBe('Pixel 8');
    expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
  });

  it('updateDeviceTarget on missing id → HttpError 404', async () => {
    const svc = await import('../src/services/deviceTargets.service.js');
    const e = await svc
      .updateDeviceTarget('00000000-0000-0000-0000-000000000000', { name: 'x', mobileOs: 'ios', deviceRef: 'y' })
      .catch((err: unknown) => err);
    const { HttpError } = await import('../src/middleware/errorHandler.js');
    expect(e).toBeInstanceOf(HttpError);
    expect((e as { status?: number }).status).toBe(404);
  });

  it('deleteDeviceTarget + getDeviceTarget returns null', async () => {
    const svc = await import('../src/services/deviceTargets.service.js');
    const created = await svc.createDeviceTarget(projectId, {
      name: 'del-1',
      mobileOs: 'ios',
      deviceRef: 'iPhone 17 Pro',
    });
    await svc.deleteDeviceTarget(created.id);
    expect(await svc.getDeviceTarget(created.id)).toBeNull();
  });

  it('deleteDeviceTarget on missing id → HttpError 404', async () => {
    const svc = await import('../src/services/deviceTargets.service.js');
    const e = await svc
      .deleteDeviceTarget('00000000-0000-0000-0000-000000000000')
      .catch((err: unknown) => err);
    const { HttpError } = await import('../src/middleware/errorHandler.js');
    expect(e).toBeInstanceOf(HttpError);
    expect((e as { status?: number }).status).toBe(404);
  });

  it('FK cascade: deleting a device target nulls test_cases.mobile_device_target_id', async () => {
    const svc = await import('../src/services/deviceTargets.service.js');
    const target = await svc.createDeviceTarget(projectId, {
      name: 'fk-target',
      mobileOs: 'ios',
      deviceRef: 'iPhone 17 Pro',
    });
    const caseId = await newCase('fk-bound');
    await pool.query(
      `UPDATE test_cases SET platform='mobile', mobile_os='ios', mobile_device_target_id=$1, app_ref=$2 WHERE id=$3`,
      [target.id, JSON.stringify({ bundleId: 'com.example.app' }), caseId],
    );
    // sanity check
    const before = await pool.query(`SELECT mobile_device_target_id FROM test_cases WHERE id = $1`, [caseId]);
    expect(before.rows[0].mobile_device_target_id).toBe(target.id);

    await svc.deleteDeviceTarget(target.id);

    const after = await pool.query(`SELECT mobile_device_target_id FROM test_cases WHERE id = $1`, [caseId]);
    expect(after.rows[0].mobile_device_target_id).toBeNull();
  });
});

describe('deviceTargets routes', () => {
  it('POST creates and returns the row', async () => {
    const r = await request(app)
      .post(`/api/projects/${projectId}/device-targets`)
      .send({ name: 'route-1', mobileOs: 'ios', deviceRef: 'iPhone 17 Pro' });
    expect(r.status).toBe(200);
    expect(r.body.id).toBeTruthy();
    expect(r.body.name).toBe('route-1');
    expect(r.body.mobileOs).toBe('ios');
  });

  it('POST duplicate name → 409', async () => {
    await request(app)
      .post(`/api/projects/${projectId}/device-targets`)
      .send({ name: 'route-dup', mobileOs: 'ios', deviceRef: 'iPhone 17 Pro' });
    const r = await request(app)
      .post(`/api/projects/${projectId}/device-targets`)
      .send({ name: 'route-dup', mobileOs: 'ios', deviceRef: 'iPhone 17 Pro' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('name_conflict');
  });

  it('GET list returns rows', async () => {
    const created = await request(app)
      .post(`/api/projects/${projectId}/device-targets`)
      .send({ name: 'route-list', mobileOs: 'android', deviceRef: 'Pixel 9' });
    const r = await request(app).get(`/api/projects/${projectId}/device-targets`);
    expect(r.status).toBe(200);
    expect(r.body.find((t: { id: string }) => t.id === created.body.id)).toBeTruthy();
  });

  it('GET 详情 returns single row', async () => {
    const created = await request(app)
      .post(`/api/projects/${projectId}/device-targets`)
      .send({ name: 'route-detail', mobileOs: 'ios', deviceRef: 'iPhone 16' });
    const r = await request(app).get(`/api/projects/${projectId}/device-targets/${created.body.id}`);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(created.body.id);
    expect(r.body.deviceRef).toBe('iPhone 16');
  });

  it('PUT updates fields', async () => {
    const created = await request(app)
      .post(`/api/projects/${projectId}/device-targets`)
      .send({ name: 'route-put', mobileOs: 'ios', deviceRef: 'iPhone 14' });
    const r = await request(app)
      .put(`/api/projects/${projectId}/device-targets/${created.body.id}`)
      .send({ name: 'route-put', mobileOs: 'android', deviceRef: 'Pixel 7' });
    expect(r.status).toBe(200);
    expect(r.body.mobileOs).toBe('android');
    expect(r.body.deviceRef).toBe('Pixel 7');
  });

  it('DELETE returns { ok: true }, GET 详情 then 404', async () => {
    const created = await request(app)
      .post(`/api/projects/${projectId}/device-targets`)
      .send({ name: 'route-del', mobileOs: 'ios', deviceRef: 'iPhone 15' });
    const del = await request(app).delete(`/api/projects/${projectId}/device-targets/${created.body.id}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true });
    const gone = await request(app).get(`/api/projects/${projectId}/device-targets/${created.body.id}`);
    expect(gone.status).toBe(404);
  });

  it('cross-project isolation: GET via foreign project URL → 404', async () => {
    const otherId = await seedProjectInOrg(pool, orgId, '别家-DT');
    const created = await request(app)
      .post(`/api/projects/${projectId}/device-targets`)
      .send({ name: 'iso-target', mobileOs: 'ios', deviceRef: 'iPhone 17 Pro' });
    const r = await request(app).get(`/api/projects/${otherId}/device-targets/${created.body.id}`);
    expect(r.status).toBe(404);
  });

  it('POST with missing name → 400 (zod)', async () => {
    const r = await request(app)
      .post(`/api/projects/${projectId}/device-targets`)
      .send({ name: '', mobileOs: 'ios', deviceRef: 'iPhone 17 Pro' });
    expect(r.status).toBe(400);
  });

  it('POST with invalid mobileOs → 400 (zod)', async () => {
    const r = await request(app)
      .post(`/api/projects/${projectId}/device-targets`)
      .send({ name: 'bad-os', mobileOs: 'symbian', deviceRef: 'whatever' });
    expect(r.status).toBe(400);
  });
});

describe('case mobile target binding', () => {
  async function newTarget(name: string): Promise<string> {
    const r = await request(app)
      .post(`/api/projects/${projectId}/device-targets`)
      .send({ name, mobileOs: 'ios', deviceRef: 'iPhone 17 Pro' });
    return r.body.id as string;
  }

  it('PATCH with platform=mobile + valid fields → 200', async () => {
    const targetId = await newTarget('bind-1');
    const caseId = await newCase('mobile-bind');
    const r = await request(app)
      .patch(`/api/cases/${caseId}`)
      .send({
        platform: 'mobile',
        mobileOs: 'ios',
        mobileDeviceTargetId: targetId,
        appRef: { bundleId: 'com.example.app' },
      });
    expect(r.status).toBe(200);
    expect(r.body.platform).toBe('mobile');
    expect(r.body.mobileOs).toBe('ios');
    expect(r.body.mobileDeviceTargetId).toBe(targetId);
    expect(r.body.appRef).toEqual({ bundleId: 'com.example.app' });
  });

  it('PATCH platform=mobile but missing appRef → 400 mobile_config_required', async () => {
    const targetId = await newTarget('bind-2');
    const caseId = await newCase('mobile-missing-appref');
    const r = await request(app)
      .patch(`/api/cases/${caseId}`)
      .send({ platform: 'mobile', mobileOs: 'ios', mobileDeviceTargetId: targetId });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('mobile_config_required');
  });

  it('PATCH platform=web nulls mobile fields', async () => {
    const targetId = await newTarget('bind-3');
    const caseId = await newCase('mobile-then-web');
    // set mobile first
    await request(app)
      .patch(`/api/cases/${caseId}`)
      .send({
        platform: 'mobile',
        mobileOs: 'ios',
        mobileDeviceTargetId: targetId,
        appRef: { bundleId: 'com.example.app' },
      });
    // flip to web
    const r = await request(app).patch(`/api/cases/${caseId}`).send({ platform: 'web' });
    expect(r.status).toBe(200);
    expect(r.body.platform).toBe('web');
    expect(r.body.mobileOs).toBeNull();
    expect(r.body.mobileDeviceTargetId).toBeNull();
    expect(r.body.appRef).toBeNull();
  });

  it('PATCH mobileDeviceTargetId from another project → 400 device_target_project_mismatch', async () => {
    const otherId = await seedProjectInOrg(pool, orgId, '别家-BIND');
    const otherTarget = await pool.query(
      `INSERT INTO device_targets(project_id, name, mobile_os, device_ref) VALUES ($1, '外案', 'ios', 'iPhone 17 Pro') RETURNING id`,
      [otherId],
    );
    const caseId = await newCase('cross-project-bind');
    const r = await request(app)
      .patch(`/api/cases/${caseId}`)
      .send({
        platform: 'mobile',
        mobileOs: 'ios',
        mobileDeviceTargetId: otherTarget.rows[0]!.id,
        appRef: { bundleId: 'com.example.app' },
      });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('device_target_project_mismatch');
  });
});