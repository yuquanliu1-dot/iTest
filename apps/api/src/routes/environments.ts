import { Router, type Request } from 'express';
import { z } from 'zod';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { environmentObjects, executionPlans, testCases, testEnvironments } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { encrypt } from '../lib/secret-crypto.js';
import { assertEnvironmentVisible, assertProjectVisible } from '../services/projectAccess.js';
import { createQueryPool, safeDecrypt, type SyslogCtx } from '../execute/envContext.js';
import { probeSyslog } from '../execute/syslogReader.js';

export const environmentsRoute = Router();

const MASK = '••••••••';
const OBJECT_TYPES = ['db', 'syslog'] as const;
type ObjectType = (typeof OBJECT_TYPES)[number];

/** 出参掩码：payload.secret（AES 三元组）→ MASK。 */
function maskObjectPayload(row: typeof environmentObjects.$inferSelect) {
  const payload = { ...((row.payload ?? {}) as Record<string, unknown>) };
  if (payload.secret) payload.secret = MASK;
  return { ...row, payload };
}

async function listEnvObjects(environmentId: string) {
  const rows = await db.select().from(environmentObjects)
    .where(eq(environmentObjects.environmentId, environmentId))
    .orderBy(asc(environmentObjects.createdAt));
  return rows.map(maskObjectPayload);
}

/**
 * 入参归一：payload.password / payload.privateKey 明文 → 加密写入 payload.secret；
 * 未提供（留空）→ 沿用 prev 旧密文（不覆盖语义）。入参中的 secret 字段一律丢弃。
 * syslog 按 authType 决定加密哪个明文字段（password / privateKey）。
 */
function normalizeObjectPayload(
  objectType: ObjectType,
  payload: Record<string, unknown>,
  prev?: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...payload };
  delete out.secret;
  const plain = objectType === 'db'
    ? out.password
    : out.authType === 'password' ? out.password : out.privateKey;
  delete out.password;
  delete out.privateKey;
  if (typeof plain === 'string' && plain.length > 0) {
    const e = encrypt(plain);
    out.secret = { c: e.ciphertext.toString('base64'), i: e.iv.toString('base64'), t: e.tag.toString('base64') };
  } else if (prev?.secret) {
    out.secret = prev.secret;
  }
  return out;
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

environmentsRoute.get('/projects/:projectId/environments', async (req, res) => {
  const projectId = (req.params as { projectId: string }).projectId;
  await assertProjectVisible(projectId, req.user!);
  const envs = await db.select().from(testEnvironments)
    .where(eq(testEnvironments.projectId, projectId))
    .orderBy(asc(testEnvironments.createdAt));
  const objs = envs.length
    ? await db.select().from(environmentObjects)
        .where(inArray(environmentObjects.environmentId, envs.map((e) => e.id)))
        .orderBy(asc(environmentObjects.createdAt))
    : [];
  const byEnv = new Map<string, typeof objs>();
  for (const o of objs) {
    const list = byEnv.get(o.environmentId) ?? [];
    list.push(o);
    byEnv.set(o.environmentId, list);
  }
  res.json(envs.map((e) => ({ ...e, objects: (byEnv.get(e.id) ?? []).map(maskObjectPayload) })));
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
  baseUrl: z.string().max(2000).optional(),
  objects: z.array(ObjectBody).max(10).optional(),
});

environmentsRoute.post('/projects/:projectId/environments', async (req, res) => {
  const projectId = (req.params as { projectId: string }).projectId;
  await assertProjectVisible(projectId, req.user!);
  const body = CreateBody.parse(req.body);
  const env = await db.transaction(async (tx) => {
    const inserted = (await tx.insert(testEnvironments).values({ projectId, name: body.name, baseUrl: body.baseUrl ?? null }).returning())[0]!;
    if (body.objects?.length) {
      await tx.insert(environmentObjects).values(body.objects.map((o) => ({
        environmentId: inserted.id,
        objectType: o.objectType,
        label: o.label ?? '默认',
        payload: normalizeObjectPayload(o.objectType, o.payload),
        isDefault: o.isDefault ?? false,
      })));
    }
    return inserted;
  }).catch((e) => {
    if (isUniqueViolation(e)) throw new HttpError(409, 'name_conflict', 'environment name already exists in this project');
    throw e;
  });
  res.json({ ...env, objects: await listEnvObjects(env.id) });
});

const EnvPatchBody = z.object({
  name: z.string().min(1).max(120).optional(),
  baseUrl: z.string().max(2000).nullable().optional(),
  isDefault: z.boolean().optional(),
});

environmentsRoute.patch('/environments/:id', async (req, res) => {
  const { projectId } = await assertEnvironmentVisible(req.params.id!, req.user!);
  const body = EnvPatchBody.parse(req.body);
  const row = await db.transaction(async (tx) => {
    if (body.isDefault === true) {
      await tx.update(testEnvironments).set({ isDefault: false }).where(eq(testEnvironments.projectId, projectId));
    }
    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) update.name = body.name;
    if (body.baseUrl !== undefined) update.baseUrl = body.baseUrl;
    if (body.isDefault !== undefined) update.isDefault = body.isDefault;
    const rows = await tx.update(testEnvironments).set(update)
      .where(and(eq(testEnvironments.id, req.params.id), eq(testEnvironments.projectId, projectId)))
      .returning();
    if (rows.length === 0) throw new HttpError(404, 'not_found', 'environment not found');
    return rows[0]!;
  }).catch((e) => {
    if (isUniqueViolation(e)) throw new HttpError(409, 'name_conflict', 'environment name already exists in this project');
    throw e;
  });
  res.json({ ...row, objects: await listEnvObjects(row.id) });
});

environmentsRoute.delete('/environments/:id', async (req, res) => {
  const { projectId } = await assertEnvironmentVisible(req.params.id!, req.user!);
  const caseCount = (await db.select({ id: testCases.id }).from(testCases).where(eq(testCases.defaultEnvId, req.params.id))).length;
  const planCount = (await db.select({ id: executionPlans.id }).from(executionPlans).where(eq(executionPlans.environmentId, req.params.id))).length;
  if (req.query.confirm !== 'true' && (caseCount > 0 || planCount > 0)) {
    res.json({ ok: false, requiresConfirm: true, caseCount, planCount });
    return;
  }
  await db.delete(testEnvironments).where(and(eq(testEnvironments.id, req.params.id), eq(testEnvironments.projectId, projectId)));
  res.json({ ok: true, caseCount, planCount });
});

environmentsRoute.post('/environments/:id/objects', async (req, res) => {
  const environmentId = req.params.id!;
  await assertEnvironmentVisible(environmentId, req.user!);
  const body = ObjectBody.parse(req.body);
  const row = await db.transaction(async (tx) => {
    if (body.isDefault) {
      await tx.update(environmentObjects).set({ isDefault: false })
        .where(and(eq(environmentObjects.environmentId, environmentId), eq(environmentObjects.objectType, body.objectType)));
    }
    return (await tx.insert(environmentObjects).values({
      environmentId,
      objectType: body.objectType,
      label: body.label ?? '默认',
      payload: normalizeObjectPayload(body.objectType, body.payload),
      isDefault: body.isDefault ?? false,
    }).returning())[0]!;
  });
  res.json(maskObjectPayload(row));
});

environmentsRoute.patch('/environment-objects/:id', async (req, res) => {
  const existing = (await db.select().from(environmentObjects).where(eq(environmentObjects.id, req.params.id)))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'environment object not found');
  await assertEnvironmentVisible(existing.environmentId, req.user!);
  const body = z.object({
    label: z.string().max(120).optional(),
    payload: z.record(z.unknown()).optional(),
  }).parse(req.body);
  const objectType = existing.objectType as ObjectType;
  const payload = body.payload !== undefined
    ? normalizeObjectPayload(objectType, body.payload, (existing.payload ?? {}) as Record<string, unknown>)
    : undefined;
  const rows = await db.update(environmentObjects).set({
    ...(body.label !== undefined ? { label: body.label } : {}),
    ...(payload !== undefined ? { payload: payload as object, updatedAt: new Date() } : {}),
  }).where(eq(environmentObjects.id, req.params.id)).returning();
  res.json(maskObjectPayload(rows[0]!));
});

environmentsRoute.delete('/environment-objects/:id', async (req, res) => {
  const existing = (await db.select().from(environmentObjects).where(eq(environmentObjects.id, req.params.id)))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'environment object not found');
  await assertEnvironmentVisible(existing.environmentId, req.user!);
  await db.transaction(async (tx) => {
    await tx.delete(environmentObjects).where(eq(environmentObjects.id, req.params.id));
    if (existing.isDefault) {
      const sibling = (await tx.select({ id: environmentObjects.id }).from(environmentObjects)
        .where(and(eq(environmentObjects.environmentId, existing.environmentId), eq(environmentObjects.objectType, existing.objectType)))
        .orderBy(asc(environmentObjects.createdAt)).limit(1))[0];
      if (sibling) await tx.update(environmentObjects).set({ isDefault: true }).where(eq(environmentObjects.id, sibling.id));
    }
  });
  res.json({ ok: true });
});

environmentsRoute.get('/environments/allowed-tables', async (_req, res) => {
  const { ALLOWED_QUERY_COLUMNS } = await import('../execute/dbQuery.js');
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(ALLOWED_QUERY_COLUMNS)) out[k] = Array.from(v);
  res.json(out);
});

type SecretTriple = { c?: string; i?: string; t?: string } | null | undefined;

/** objectId 回退：取该对象已存密文解出明文（凭据留空走旧密文，与保存语义一致）。
 *  对象不存在 → 404；无密文 → ''；解密失败 → error（调用方回 200 ok:false）。 */
async function storedSecret(objectId: string, req: Request): Promise<{ secret: string; error?: string }> {
  const row = (await db.select().from(environmentObjects).where(eq(environmentObjects.id, objectId)).limit(1))[0];
  if (!row) throw new HttpError(404, 'not_found', 'environment object not found');
  await assertEnvironmentVisible(row.environmentId, req.user!);
  const p = (row.payload ?? {}) as { secret?: SecretTriple };
  if (p.secret?.c && p.secret?.i && p.secret?.t) {
    try {
      return { secret: safeDecrypt(p.secret) };
    } catch (e) {
      return { secret: '', error: `凭据解密失败：${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return { secret: '' };
}

const TestDbBody = z.object({
  objectId: z.string().uuid().optional(), // 编辑态：密码留空时回退该对象已存密文
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).optional(),
  dbName: z.string().min(1),
  user: z.string().min(1),
  password: z.string().optional(), // 明文留空 → 沿用旧密文（与保存语义一致）
  dbType: z.enum(['postgres', 'mysql']).optional(), // 缺省 postgres（老数据兼容）
});

// 用表单当前值（未保存也可）探测 DB 连通性；HTTP 200 + ok:false 表示探测失败（与 /settings/llm/test 约定一致）
environmentsRoute.post('/environments/test-db', async (req, res) => {
  const body = TestDbBody.parse(req.body);
  let password = body.password ?? '';
  if (!password && body.objectId) {
    const stored = await storedSecret(body.objectId, req);
    if (stored.error) {
      res.json({ ok: false, error: stored.error });
      return;
    }
    password = stored.secret;
  }
  const dialect = body.dbType ?? 'postgres';
  const pool = createQueryPool({
    dialect,
    host: body.host,
    port: body.port ?? (dialect === 'mysql' ? 3306 : 5432),
    database: body.dbName,
    user: body.user,
    password,
  });
  const startedAt = Date.now();
  try {
    await pool.query('SELECT 1', []);
    res.json({ ok: true, latencyMs: Date.now() - startedAt });
  } catch (e) {
    res.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  } finally {
    await pool.end().catch(() => undefined);
  }
});

const TestSyslogBody = z.object({
  objectId: z.string().uuid().optional(), // 编辑态：凭据留空时回退该对象已存密文
  host: z.string().min(1),
  sshPort: z.number().int().min(1).max(65535).optional(), // 与 payload.sshPort 同名：表单同一映射共用
  user: z.string().min(1),
  filePath: z.string().min(1),
  authType: z.enum(['key', 'password']),
  privateKey: z.string().optional(),
  password: z.string().optional(),
});

// 用表单当前值（未保存也可）探测 syslog（SSH tail 校验文件可读）；200 + ok:false 表示探测失败
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
    res.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
