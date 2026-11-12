import { Router, type Request } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { resolveDbDialect, defaultDbPort } from '@itest/shared';
import { db } from '../db/client.js';
import { environmentObjects } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import {
  listEnvironments, createEnvironment, updateEnvironment, deleteEnvironment, environmentUsage,
  insertEnvironmentObject, updateEnvironmentObject, deleteEnvironmentObject, getEnvironment,
  maskObjectPayload,
} from '../services/environments.service.js';
import { assertEnvironmentVisible, assertProjectVisible } from '../services/projectAccess.js';
import { createQueryPool, safeDecrypt, type SyslogCtx } from '../execute/envContext.js';
import { probeSyslog } from '../execute/syslogReader.js';

export const environmentsRoute = Router();

const OBJECT_TYPES = ['db', 'syslog', 'web'] as const;

environmentsRoute.get('/projects/:projectId/environments', async (req, res) => {
  const projectId = (req.params as { projectId: string }).projectId;
  await assertProjectVisible(projectId, req.user!);
  res.json(await listEnvironments(projectId));
});

const ObjectTypeEnum = z.enum(OBJECT_TYPES);
const ObjectBody = z.object({
  objectType: ObjectTypeEnum,
  label: z.string().max(120).optional(),
  payload: z.record(z.unknown()).default({}),
  isDefault: z.boolean().optional(),
});
const CreateBody = z.object({
  name: z.string().min(1).max(120),
  objects: z.array(ObjectBody).max(10).optional(),
});

environmentsRoute.post('/projects/:projectId/environments', async (req, res) => {
  const projectId = (req.params as { projectId: string }).projectId;
  await assertProjectVisible(projectId, req.user!);
  const body = CreateBody.parse(req.body);
  const env = await createEnvironment(projectId, body, req.user!.userId);
  res.json(await getEnvironment(env.id));
});

const EnvPatchBody = z.object({
  name: z.string().min(1).max(120).optional(),
  isDefault: z.boolean().optional(),
});

environmentsRoute.patch('/environments/:id', async (req, res) => {
  await assertEnvironmentVisible(req.params.id!, req.user!);
  const body = EnvPatchBody.parse(req.body);
  res.json(await updateEnvironment(req.params.id!, body));
});

environmentsRoute.delete('/environments/:id', async (req, res) => {
  await assertEnvironmentVisible(req.params.id!, req.user!);
  const { caseCount, planCount } = await environmentUsage(req.params.id!);
  if (req.query.confirm !== 'true' && (caseCount > 0 || planCount > 0)) {
    res.json({ ok: false, requiresConfirm: true, caseCount, planCount });
    return;
  }
  await deleteEnvironment(req.params.id!);
  res.json({ ok: true, caseCount, planCount });
});

environmentsRoute.post('/environments/:id/objects', async (req, res) => {
  const environmentId = req.params.id!;
  await assertEnvironmentVisible(environmentId, req.user!);
  const body = ObjectBody.parse(req.body);
  res.json(await insertEnvironmentObject(environmentId, body));
});

environmentsRoute.patch('/environment-objects/:id', async (req, res) => {
  const existing = (await db.select().from(environmentObjects).where(eq(environmentObjects.id, req.params.id)))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'environment object not found');
  await assertEnvironmentVisible(existing.environmentId, req.user!);
  const body = z.object({
    label: z.string().max(120).optional(),
    payload: z.record(z.unknown()).optional(),
  }).parse(req.body);
  res.json(maskObjectPayload(await updateEnvironmentObject(req.params.id!, body)));
});

environmentsRoute.delete('/environment-objects/:id', async (req, res) => {
  const existing = (await db.select().from(environmentObjects).where(eq(environmentObjects.id, req.params.id)))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'environment object not found');
  await assertEnvironmentVisible(existing.environmentId, req.user!);
  await deleteEnvironmentObject(req.params.id!);
  res.json({ ok: true });
});

type SecretTriple = { c?: string; i?: string; t?: string } | null | undefined;

/** objectId fallback: decrypt the stored ciphertext of that object (empty credentials reuse the old ciphertext, same semantics as saving).
 *  Object missing → 404; no ciphertext → ''; decryption failure → error (caller returns 200 ok:false).
 *  Returns the original payload too — the caller still needs its url (jdbc prefix) to infer the DB type. */
async function storedSecret(objectId: string, req: Request): Promise<{ secret: string; error?: string; payload: Record<string, unknown> }> {
  const row = (await db.select().from(environmentObjects).where(eq(environmentObjects.id, objectId)).limit(1))[0];
  if (!row) throw new HttpError(404, 'not_found', 'environment object not found');
  await assertEnvironmentVisible(row.environmentId, req.user!);
  const p = (row.payload ?? {}) as { secret?: SecretTriple } & Record<string, unknown>;
  if (p.secret?.c && p.secret?.i && p.secret?.t) {
    try {
      return { secret: safeDecrypt(p.secret), payload: p };
    } catch (e) {
      return { secret: '', error: `凭据解密失败：${e instanceof Error ? e.message : String(e)}`, payload: p };
    }
  }
  return { secret: '', payload: p };
}

// mysql2/ssh2 network errors often only carry code (e.g. ETIMEDOUT/ECONNREFUSED) with an empty message → concatenate to keep it readable
function probeErrorText(e: unknown): string {
  if (e instanceof Error) {
    return [e.message, (e as NodeJS.ErrnoException).code].filter(Boolean).join(' ') || '未知错误';
  }
  return String(e) || '未知错误';
}

const TestDbBody = z.object({
  objectId: z.string().uuid().optional(), // Edit mode: when the password is left empty, fall back to the object's stored ciphertext
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).optional(),
  dbName: z.string().min(1),
  user: z.string().min(1),
  password: z.string().optional(), // Plaintext left empty → keep the old ciphertext (same semantics as saving)
  dbType: z.enum(['postgres', 'mysql', 'gauss100']).optional(),
  url: z.string().optional(), // jdbc url: used to infer DB type when dbType is missing (same logic as runtime resolveDbDialect)
});

// Probe DB connectivity using the form's current values (unsaved is fine); HTTP 200 + ok:false means the probe failed (same convention as /settings/llm/test)
environmentsRoute.post('/environments/test-db', async (req, res) => {
  const body = TestDbBody.parse(req.body);
  let password = body.password ?? '';
  let url = body.url;
  if (body.objectId) {
    const stored = await storedSecret(body.objectId, req);
    if (!password && stored.error) {
      res.json({ ok: false, error: stored.error });
      return;
    }
    password = stored.secret;
    // The form doesn't show url, but the stored object's url is the fallback signal for "infer DB type when dbType is missing" — backfill it.
    const storedUrl = stored.payload.url;
    url = url ?? (typeof storedUrl === 'string' ? storedUrl : undefined);
  }
  // DB type resolution matches runtime (apps/api/src/execute/envContext.ts): dbType takes priority;
  // otherwise infer from the jdbc url prefix; only fall back to postgres when neither is available.
  const dialect = resolveDbDialect({ dbType: body.dbType, url });
  const pool = createQueryPool({
    dialect,
    host: body.host,
    port: body.port ?? defaultDbPort(dialect),
    database: body.dbName,
    user: body.user,
    password,
  });
  const startedAt = Date.now();
  try {
    await pool.query('SELECT 1', []);
    res.json({ ok: true, latencyMs: Date.now() - startedAt });
  } catch (e) {
    res.json({ ok: false, error: probeErrorText(e) });
  } finally {
    await pool.end().catch(() => undefined);
  }
});

const TestSyslogBody = z.object({
  objectId: z.string().uuid().optional(), // Edit mode: when credentials are left empty, fall back to the object's stored ciphertext
  host: z.string().min(1),
  sshPort: z.number().int().min(1).max(65535).optional(), // Same name as payload.sshPort: shared by the same form mapping
  user: z.string().min(1),
  filePath: z.string().min(1),
  authType: z.enum(['key', 'password']),
  privateKey: z.string().optional(),
  password: z.string().optional(),
});

// Probe syslog using the form's current values (unsaved is fine; SSH tail verifies the file is readable); 200 + ok:false means the probe failed
environmentsRoute.post('/environments/test-syslog', async (req, res) => {
  const body = TestSyslogBody.parse(req.body);
  let secret = body.authType === 'password' ? (body.password ?? '') : (body.privateKey ?? '');
  if (!secret && body.objectId) {
    const stored = await storedSecret(body.objectId, req);
    if (stored.error) {
      res.json({ ok: false, error: stored.error });
      return;
    }
    secret = stored.secret;
  }
  const env: SyslogCtx = {
    host: body.host,
    port: body.sshPort ?? 22,
    user: body.user,
    filePath: body.filePath,
    authType: body.authType,
    ...(body.authType === 'password' ? { password: secret } : { privateKey: Buffer.from(secret) }),
  };
  try {
    const latencyMs = await probeSyslog(env);
    res.json({ ok: true, latencyMs });
  } catch (e) {
    res.json({ ok: false, error: probeErrorText(e) });
  }
});
