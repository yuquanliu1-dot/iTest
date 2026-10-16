/**
 * 环境领域服务:环境与对象(db/syslog)的增删改查。
 * 秘密以 AES-256-GCM {c,i,t} 存 payload.secret;出参一律经 maskObjectPayload 脱敏。
 * 用户可见性(assertProjectVisible/assertEnvironmentVisible)由调用方(HTTP 边界)负责。
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { VAR_NAME_RE } from '@itest/shared';
import { db } from '../db/client.js';
import { environmentObjects, executionPlans, testCases, testEnvironments } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { encrypt } from '../lib/secret-crypto.js';
import { attachCreators, attachCreator } from '../lib/creator.js';

export const OBJECT_MASK = '••••••••';
const OBJECT_TYPES = ['db', 'syslog', 'login', 'web'] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

/** 出参掩码:payload.secret(AES 三元组)→ OBJECT_MASK,同时输出 hasSecret 标志位
 *  让前端可判定"已加密保存",不依赖反向解析被 mask 的 secret。 */
export function maskObjectPayload(row: typeof environmentObjects.$inferSelect) {
  const raw = (row.payload ?? {}) as Record<string, unknown>;
  const hasSecret = Boolean(raw.secret);
  const payload = { ...raw };
  if (hasSecret) payload.secret = OBJECT_MASK;
  return { ...row, payload, hasSecret };
}

/**
 * 入参归一:payload.password / payload.privateKey 明文 → 加密写入 payload.secret;
 * 未提供(留空)→ 沿用 prev 旧密文(不覆盖语义)。入参中的 secret 字段一律丢弃
 * (含 OBJECT_MASK 占位串——这是脱敏值,绝不能当作真值写回)。
 * syslog 按 authType 决定加密哪个明文字段(password / privateKey);db / login 用 password。
 */
export function normalizeObjectPayload(
  objectType: ObjectType,
  payload: Record<string, unknown>,
  prev?: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...payload };
  // 入参里的 secret 一律丢弃——可能是脱敏串,绝不写回
  delete out.secret;
  const plain = objectType === 'syslog'
    ? (out.authType === 'password' ? out.password : out.privateKey)
    : out.password;
  delete out.password;
  delete out.privateKey;
  if (typeof plain === 'string' && plain.length > 0) {
    const e = encrypt(plain);
    out.secret = { c: e.ciphertext.toString('base64'), i: e.iv.toString('base64'), t: e.tag.toString('base64') };
  } else if (prev?.secret && typeof prev.secret === 'object') {
    // 仅当 prev.secret 是合法 AES 三元组时才沿用(过滤掉历史脏数据里的占位串)
    out.secret = prev.secret;
  }
  return out;
}

/** web 对象 payload 校验:name 可空(空=仅默认服务不可被引用)、合法则须为变量名字符且 ≤64;
 *  scheme http/https(缺省 http);host 必填;port 可空整数。同环境 name 唯一。 */
async function assertWebPayload(
  tx: Pick<typeof db, 'select'>,
  environmentId: string,
  payload: Record<string, unknown>,
  selfObjectId?: string,
) {
  const name = typeof payload.name === 'string' && payload.name.length > 0 ? payload.name : null;
  if (name !== null && !VAR_NAME_RE.test(name)) {
    throw new HttpError(400, 'invalid_web_name', 'web 服务 name 只能包含字母、数字、下划线,且以字母或下划线开头');
  }
  // name 上限 64,与 test_cases.web_service_ref varchar(64) 对齐
  if (name !== null && name.length > 64) {
    throw new HttpError(400, 'invalid_web_name', 'web 服务 name 长度不能超过 64');
  }
  if (payload.scheme !== undefined && payload.scheme !== 'http' && payload.scheme !== 'https') {
    throw new HttpError(400, 'invalid_web_scheme', 'web 服务 scheme 只能是 http 或 https');
  }
  if (typeof payload.host !== 'string' || payload.host.trim().length === 0) {
    throw new HttpError(400, 'invalid_web_host', 'web 服务 host 不能为空');
  }
  if (payload.port !== undefined && payload.port !== null && !Number.isInteger(payload.port)) {
    throw new HttpError(400, 'invalid_web_port', 'web 服务 port 必须是整数');
  }
  if (name !== null) {
    const rows = await tx.select({ id: environmentObjects.id, payload: environmentObjects.payload }).from(environmentObjects)
      .where(eq(environmentObjects.environmentId, environmentId));
    const dup = rows.some((r) => {
      if (selfObjectId && r.id === selfObjectId) return false;
      const p = r.payload as Record<string, unknown>;
      return p?.name === name;
    });
    if (dup) throw new HttpError(409, 'web_name_conflict', `web 服务 name "${name}" 在该环境已存在`);
  }
}

export function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

async function objectsOf(environmentId: string) {
  const rows = await db.select().from(environmentObjects)
    .where(eq(environmentObjects.environmentId, environmentId))
    .orderBy(asc(environmentObjects.createdAt));
  return rows.map(maskObjectPayload);
}

export async function listEnvironments(projectId: string) {
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
  return attachCreators(envs.map((e) => ({ ...e, objects: (byEnv.get(e.id) ?? []).map(maskObjectPayload) })));
}

export async function getEnvironment(environmentId: string) {
  const env = (await db.select().from(testEnvironments).where(eq(testEnvironments.id, environmentId)).limit(1))[0];
  if (!env) return null;
  return attachCreator({ ...env, objects: await objectsOf(env.id) });
}

export async function createEnvironment(
  projectId: string,
  input: { name: string; baseUrl?: string | null; objects?: Array<{ objectType: ObjectType; label?: string; payload: Record<string, unknown>; isDefault?: boolean }> },
  createdByUserId?: string | null,
) {
  return db.transaction(async (tx) => {
    const inserted = (await tx.insert(testEnvironments).values({ projectId, name: input.name, baseUrl: input.baseUrl ?? null, ...(createdByUserId ? { createdByUserId } : {}) }).returning())[0]!;
    if (input.objects?.length) {
      // 逐条先校验再插入:web 对象走 assertWebPayload;同事务内后续校验能看到已插入行,
      // 同请求里两个同名 web 对象因此同样被拒(409)。
      for (const o of input.objects) {
        if (o.objectType === 'web') {
          await assertWebPayload(tx, inserted.id, o.payload);
        }
        await tx.insert(environmentObjects).values({
          environmentId: inserted.id,
          objectType: o.objectType,
          label: o.label ?? '默认',
          payload: normalizeObjectPayload(o.objectType, o.payload),
          isDefault: o.isDefault ?? false,
        });
      }
    }
    return inserted;
  }).catch((e) => {
    if (isUniqueViolation(e)) throw new HttpError(409, 'name_conflict', 'environment name already exists in this project');
    throw e;
  });
}

export async function updateEnvironment(environmentId: string, patch: { name?: string; baseUrl?: string | null; isDefault?: boolean }) {
  const row = await db.transaction(async (tx) => {
    const env = (await tx.select().from(testEnvironments).where(eq(testEnvironments.id, environmentId)).limit(1))[0];
    if (!env) throw new HttpError(404, 'not_found', 'environment not found');
    if (patch.isDefault === true) {
      await tx.update(testEnvironments).set({ isDefault: false }).where(eq(testEnvironments.projectId, env.projectId));
    }
    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) update.name = patch.name;
    if (patch.baseUrl !== undefined) update.baseUrl = patch.baseUrl;
    if (patch.isDefault !== undefined) update.isDefault = patch.isDefault;
    return (await tx.update(testEnvironments).set(update).where(eq(testEnvironments.id, environmentId)).returning())[0]!;
  }).catch((e) => {
    if (isUniqueViolation(e)) throw new HttpError(409, 'name_conflict', 'environment name already exists in this project');
    throw e;
  });
  return { ...row, objects: await objectsOf(row.id) };
}

/** 删除前的引用计数(用例默认环境 + 计划环境)。 */
export async function environmentUsage(environmentId: string): Promise<{ caseCount: number; planCount: number }> {
  const caseCount = (await db.select({ id: testCases.id }).from(testCases).where(eq(testCases.defaultEnvId, environmentId))).length;
  const planCount = (await db.select({ id: executionPlans.id }).from(executionPlans).where(eq(executionPlans.environmentId, environmentId))).length;
  return { caseCount, planCount };
}

export async function deleteEnvironment(environmentId: string): Promise<void> {
  const deleted = await db.delete(testEnvironments).where(eq(testEnvironments.id, environmentId)).returning({ id: testEnvironments.id });
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'environment not found');
}

/** 新建对象(insert 语义,与原路由 POST /environments/:id/objects 一致)。 */
export async function insertEnvironmentObject(
  environmentId: string,
  input: { objectType: ObjectType; label?: string; payload: Record<string, unknown>; isDefault?: boolean },
) {
  const row = await db.transaction(async (tx) => {
    if (input.objectType === 'web') {
      await assertWebPayload(tx, environmentId, input.payload);
    }
    if (input.isDefault) {
      await tx.update(environmentObjects).set({ isDefault: false })
        .where(and(eq(environmentObjects.environmentId, environmentId), eq(environmentObjects.objectType, input.objectType)));
    }
    return (await tx.insert(environmentObjects).values({
      environmentId,
      objectType: input.objectType,
      label: input.label ?? '默认',
      payload: normalizeObjectPayload(input.objectType, input.payload),
      isDefault: input.isDefault ?? false,
    }).returning())[0]!;
  });
  return maskObjectPayload(row);
}

/** upsert(工具语义):同 (environmentId, objectType, label) 存在则合并 payload(旧密文沿用),否则新建。 */
export async function upsertEnvironmentObject(
  environmentId: string,
  input: { objectType: ObjectType; label?: string; payload: Record<string, unknown>; isDefault?: boolean },
) {
  const label = input.label ?? '默认';
  const row = await db.transaction(async (tx) => {
    if (input.isDefault) {
      await tx.update(environmentObjects).set({ isDefault: false })
        .where(and(eq(environmentObjects.environmentId, environmentId), eq(environmentObjects.objectType, input.objectType)));
    }
    const existing = (await tx.select().from(environmentObjects)
      .where(and(eq(environmentObjects.environmentId, environmentId), eq(environmentObjects.objectType, input.objectType), eq(environmentObjects.label, label)))
      .limit(1))[0];
    if (existing) {
      const prev = (existing.payload ?? {}) as Record<string, unknown>;
      if (input.objectType === 'web') {
        // 合并后校验:部分字段 upsert 靠 merge 补全(如只改 port),不能按裸入参全量卡
        await assertWebPayload(tx, environmentId, { ...prev, ...input.payload }, existing.id);
      }
      // prev 是从 DB 直读的原始行（含密文三元组），不是掩码后行——直接传进 normalizeObjectPayload 即可
      // input.payload 通常来自调用方（AI 工具 / HTTP 入参），不含 secret
      const payload = normalizeObjectPayload(input.objectType, { ...prev, ...input.payload }, prev);
      const update: Record<string, unknown> = { payload, updatedAt: new Date() };
      if (input.isDefault !== undefined) update.isDefault = input.isDefault;
      return (await tx.update(environmentObjects).set(update).where(eq(environmentObjects.id, existing.id)).returning())[0]!;
    }
    if (input.objectType === 'web') {
      await assertWebPayload(tx, environmentId, input.payload);
    }
    return (await tx.insert(environmentObjects).values({
      environmentId,
      objectType: input.objectType,
      label,
      payload: normalizeObjectPayload(input.objectType, input.payload),
      isDefault: input.isDefault ?? false,
    }).returning())[0]!;
  });
  return maskObjectPayload(row);
}

export async function updateEnvironmentObject(objectId: string, patch: { label?: string; payload?: Record<string, unknown> }) {
  const existing = (await db.select().from(environmentObjects).where(eq(environmentObjects.id, objectId)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'environment object not found');
  const payload = patch.payload !== undefined
    ? normalizeObjectPayload(existing.objectType as ObjectType, patch.payload, (existing.payload ?? {}) as Record<string, unknown>)
    : undefined;
  if (payload !== undefined && existing.objectType === 'web') {
    await assertWebPayload(db, existing.environmentId, payload, objectId);
  }
  const rows = await db.update(environmentObjects).set({
    ...(patch.label !== undefined ? { label: patch.label } : {}),
    ...(payload !== undefined ? { payload: payload as object, updatedAt: new Date() } : {}),
  }).where(eq(environmentObjects.id, objectId)).returning();
  return maskObjectPayload(rows[0]!);
}

export async function deleteEnvironmentObject(objectId: string): Promise<void> {
  const existing = (await db.select().from(environmentObjects).where(eq(environmentObjects.id, objectId)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'environment object not found');
  await db.transaction(async (tx) => {
    await tx.delete(environmentObjects).where(eq(environmentObjects.id, objectId));
    if (existing.isDefault) {
      const sibling = (await tx.select({ id: environmentObjects.id }).from(environmentObjects)
        .where(and(eq(environmentObjects.environmentId, existing.environmentId), eq(environmentObjects.objectType, existing.objectType)))
        .orderBy(asc(environmentObjects.createdAt)).limit(1))[0];
      if (sibling) await tx.update(environmentObjects).set({ isDefault: true }).where(eq(environmentObjects.id, sibling.id));
    }
  });
}

/** 工具 set_secret:直接替换 payload.secret(加密),其余字段不动。返回脱敏行。 */
export async function setEnvironmentObjectSecret(objectId: string, plain: string) {
  const existing = (await db.select().from(environmentObjects).where(eq(environmentObjects.id, objectId)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'environment object not found');
  const e = encrypt(plain);
  const payload = {
    ...((existing.payload ?? {}) as Record<string, unknown>),
    secret: { c: e.ciphertext.toString('base64'), i: e.iv.toString('base64'), t: e.tag.toString('base64') },
  };
  const updated = (await db.update(environmentObjects).set({ payload: payload as object, updatedAt: new Date() })
    .where(eq(environmentObjects.id, objectId)).returning())[0]!;
  return maskObjectPayload(updated);
}

/** 按 (environmentId, objectType, label) 定位对象(工具 set_secret 用)。返回原始行(含密文)。 */
export async function findEnvironmentObject(environmentId: string, objectType: ObjectType, label?: string) {
  const row = (await db.select().from(environmentObjects)
    .where(and(eq(environmentObjects.environmentId, environmentId), eq(environmentObjects.objectType, objectType), eq(environmentObjects.label, label ?? '默认')))
    .limit(1))[0];
  return row ?? null;
}
