import { Router, type Request } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
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

const OBJECT_TYPES = ['db', 'syslog', 'login', 'web'] as const;

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

// mysql2/ssh2 的网络错误常只有 code（如 ETIMEDOUT/ECONNREFUSED）而 message 为空 → 拼接保证可读
function probeErrorText(e: unknown): string {
  if (e instanceof Error) {
    return [e.message, (e as NodeJS.ErrnoException).code].filter(Boolean).join(' ') || '未知错误';
  }
  return String(e) || '未知错误';
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
    res.json({ ok: false, error: probeErrorText(e) });
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
    res.json({ ok: false, error: probeErrorText(e) });
  }
});
