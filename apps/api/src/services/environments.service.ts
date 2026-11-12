/**
 * Environment domain service: CRUD for environments and their objects (db/syslog).
 * Secrets are stored AES-256-GCM as {c,i,t} in payload.secret; outputs always go through maskObjectPayload for masking.
 * User visibility (assertProjectVisible/assertEnvironmentVisible) is the caller's job (HTTP boundary).
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { VAR_NAME_RE, dialectFromJdbcUrl } from '@itest/shared';
import { db } from '../db/client.js';
import { environmentObjects, executionPlans, planCaseGroups, testCases, testEnvironments } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { encrypt } from '../lib/secret-crypto.js';
import { attachCreators, attachCreator } from '../lib/creator.js';

export const OBJECT_MASK = '••••••••';
const OBJECT_TYPES = ['db', 'syslog', 'web'] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

/** Output masking: payload.secret (AES triplet) → OBJECT_MASK, plus a hasSecret flag so the frontend
 *  can tell "encrypted and saved" without reverse-parsing the masked secret. */
export function maskObjectPayload(row: typeof environmentObjects.$inferSelect) {
  const raw = (row.payload ?? {}) as Record<string, unknown>;
  const hasSecret = Boolean(raw.secret);
  const payload = { ...raw };
  if (hasSecret) payload.secret = OBJECT_MASK;
  return { ...row, payload, hasSecret };
}

/**
 * Input normalization: payload.password / payload.privateKey plaintext → encrypted into payload.secret;
 * when absent (left empty) → keep prev's old ciphertext (no-overwrite semantics). The secret field in the input is
 * always dropped (including the OBJECT_MASK placeholder — it's a masked value and must never be written back as real).
 * syslog picks which plaintext field to encrypt by authType (password / privateKey); db / web use password.
 * Since 0041 web carries app login credentials: user / loginUrl pass through as-is, password is encrypted into payload.secret.
 */
export function normalizeObjectPayload(
  objectType: ObjectType,
  payload: Record<string, unknown>,
  prev?: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...payload };
  // The input's secret is always dropped — it may be a masked string and is never written back
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
    // Keep prev.secret only when it's a valid AES triplet (filters placeholder strings left behind by historical dirty data)
    out.secret = prev.secret;
  }
  return out;
}

/** web object payload validation: name may be empty (empty = default-only service, not referenceable) and when present must be
 *  variable-name characters ≤64; scheme http/https (default http); host required; port an optional integer. Name unique per environment. */
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
  // name capped at 64, aligned with test_cases.web_service_ref varchar(64)
  if (name !== null && name.length > 64) {
    throw new HttpError(400, 'invalid_web_name', 'web 服务 name 长度不能超过 64');
  }
  if (payload.scheme !== undefined && payload.scheme !== null && payload.scheme !== 'http' && payload.scheme !== 'https') {
    throw new HttpError(400, 'invalid_web_scheme', 'web 服务 scheme 只能是 http 或 https');
  }
  if (typeof payload.host !== 'string' || payload.host.trim().length === 0) {
    throw new HttpError(400, 'invalid_web_host', 'web 服务 host 不能为空');
  }
  if (payload.port !== undefined && payload.port !== null && !Number.isInteger(payload.port)) {
    throw new HttpError(400, 'invalid_web_port', 'web 服务 port 必须是整数');
  }
  // Since 0041 web may carry app login credentials (one-to-one): user/loginUrl/password optional, password is transient plaintext,
  // handed to normalizeObjectPayload to encrypt into payload.secret; only light type checks here.
  for (const k of ['user', 'loginUrl', 'password'] as const) {
    const v = payload[k];
    if (v !== undefined && v !== null && typeof v !== 'string') {
      throw new HttpError(400, 'invalid_web_credentials', `web 服务 ${k} 必须是字符串`);
    }
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

/** db object payload validation: dbType legal; host/dbName/user are strings; the url's jdbc dialect must not conflict with dbType.
 *
 *  Why it exists (2026-10-28 prod228 field test): db/syslog payloads had no validation at all before,
 *  and the AI tool's upsert stored whatever was written — a db object with `url: jdbc:mysql://…` but missing
 *  `dbType` got treated as PG at runtime ("default postgres") while dialing MySQL, and the resulting
 *  `Connection terminated unexpectedly` completely masked the real cause.
 *
 *  Two checks:
 *  1. When dbType is given explicitly it must be one of postgres/mysql/gauss100 (a misspelled value fails early —
 *     better than silently walking the default at runtime).
 *  2. When url is present its jdbc dialect must not conflict with dbType (jdbc:mysql:// + dbType=postgres
 *     is a self-contradictory config; reject it outright instead of letting it explode at runtime).
 *
 *  The validation target is the "merged payload". When an inherited url contradicts the caller-declared dbType,
 *  mergeDbPayload drops the stale url before validating — an unrelated field edit shouldn't be rejected by legacy metadata.
 */
function assertDbPayload(payload: Record<string, unknown>): void {
  const dbType = payload.dbType;
  if (dbType !== undefined && dbType !== null && dbType !== 'postgres' && dbType !== 'mysql' && dbType !== 'gauss100') {
    throw new HttpError(400, 'invalid_db_type', '数据库类型只能是 postgres、mysql 或 gauss100');
  }
  for (const k of ['host', 'dbName', 'user'] as const) {
    const v = payload[k];
    if (v !== undefined && v !== null && typeof v !== 'string') {
      throw new HttpError(400, 'invalid_db_payload', `数据库对象 ${k} 必须是字符串`);
    }
  }
  const fromUrl = dialectFromJdbcUrl(payload.url);
  if (fromUrl && dbType !== undefined && dbType !== null && dbType !== fromUrl) {
    throw new HttpError(
      400, 'invalid_db_payload',
      `数据库类型 ${String(dbType)} 与 url 的库型（${fromUrl}）冲突`,
    );
  }
}

/** db payload merge (used by update / the upsert-existing branch): inherits prev's metadata (url, type, and other fields the UI doesn't show).
 *
 *  The stale url is dropped only when "the caller explicitly declared a dbType that contradicts the inherited url" —
 *  dbType is the authoritative dialect (resolveDbDialect prefers dbType too); keeping a contradictory url only misleads.
 *  When the caller brings its own url, the caller wins and nothing is dropped.
 */
function mergeDbPayload(prev: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...prev, ...incoming };
  if (incoming.url === undefined && incoming.dbType !== undefined) {
    const fromPrevUrl = dialectFromJdbcUrl(prev.url);
    if (fromPrevUrl && fromPrevUrl !== incoming.dbType) delete merged.url;
  }
  return merged;
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
  input: { name: string; objects?: Array<{ objectType: ObjectType; label?: string; payload: Record<string, unknown>; isDefault?: boolean }> },
  createdByUserId?: string | null,
) {
  return db.transaction(async (tx) => {
    const inserted = (await tx.insert(testEnvironments).values({ projectId, name: input.name, ...(createdByUserId ? { createdByUserId } : {}) }).returning())[0]!;
    if (input.objects?.length) {
      // Validate each object before inserting: web objects go through assertWebPayload; later checks in the same transaction
      // can see already-inserted rows, so two same-named web objects in one request are both rejected (409).
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

export async function updateEnvironment(environmentId: string, patch: { name?: string; isDefault?: boolean }) {
  const row = await db.transaction(async (tx) => {
    const env = (await tx.select().from(testEnvironments).where(eq(testEnvironments.id, environmentId)).limit(1))[0];
    if (!env) throw new HttpError(404, 'not_found', 'environment not found');
    if (patch.isDefault === true) {
      await tx.update(testEnvironments).set({ isDefault: false }).where(eq(testEnvironments.projectId, env.projectId));
    }
    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) update.name = patch.name;
    if (patch.isDefault !== undefined) update.isDefault = patch.isDefault;
    return (await tx.update(testEnvironments).set(update).where(eq(testEnvironments.id, environmentId)).returning())[0]!;
  }).catch((e) => {
    if (isUniqueViolation(e)) throw new HttpError(409, 'name_conflict', 'environment name already exists in this project');
    throw e;
  });
  return { ...row, objects: await objectsOf(row.id) };
}

/** Reference count before delete (case default environments + plan group environments). */
export async function environmentUsage(environmentId: string): Promise<{ caseCount: number; planCount: number }> {
  const caseCount = (await db.select({ id: testCases.id }).from(testCases).where(eq(testCases.defaultEnvId, environmentId))).length;
  const planCount = (await db.selectDistinct({ id: executionPlans.id }).from(executionPlans)
    .innerJoin(planCaseGroups, eq(planCaseGroups.planId, executionPlans.id))
    .where(eq(planCaseGroups.environmentId, environmentId))).length;
  return { caseCount, planCount };
}

export async function deleteEnvironment(environmentId: string): Promise<void> {
  const deleted = await db.delete(testEnvironments).where(eq(testEnvironments.id, environmentId)).returning({ id: testEnvironments.id });
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'environment not found');
}

/** Creates an object (insert semantics, matching the original route POST /environments/:id/objects). */
export async function insertEnvironmentObject(
  environmentId: string,
  input: { objectType: ObjectType; label?: string; payload: Record<string, unknown>; isDefault?: boolean },
) {
  const row = await db.transaction(async (tx) => {
    if (input.objectType === 'web') {
      await assertWebPayload(tx, environmentId, input.payload);
    }
    if (input.objectType === 'db') {
      assertDbPayload(input.payload);
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

/** Upsert (tool semantics): when the same (environmentId, objectType, label) exists, merge the payload (keeping the old ciphertext); otherwise create. */
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
        // Validate after merging: partial-field upserts rely on the merge to fill in (e.g. changing only port), so the raw input can't be validated as the whole
        await assertWebPayload(tx, environmentId, { ...prev, ...input.payload }, existing.id);
      }
      // prev is the raw row read straight from the DB (ciphertext triplet included), not the masked row — pass it directly into normalizeObjectPayload
      // input.payload usually comes from the caller (AI tool / HTTP input) and carries no secret
      const merged = input.objectType === 'db' ? mergeDbPayload(prev, input.payload) : { ...prev, ...input.payload };
      if (input.objectType === 'db') {
        assertDbPayload(merged);
      }
      const payload = normalizeObjectPayload(input.objectType, merged, prev);
      const update: Record<string, unknown> = { payload, updatedAt: new Date() };
      if (input.isDefault !== undefined) update.isDefault = input.isDefault;
      return (await tx.update(environmentObjects).set(update).where(eq(environmentObjects.id, existing.id)).returning())[0]!;
    }
    if (input.objectType === 'web') {
      await assertWebPayload(tx, environmentId, input.payload);
    }
    if (input.objectType === 'db') {
      assertDbPayload(input.payload);
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
  const prev = (existing.payload ?? {}) as Record<string, unknown>;
  // db objects merge prev: the payload's url(jdbc:…) and type are metadata the UI form doesn't show;
  // the form only sends dbType/host/port/dbName/user on each save — without the merge, saving would wipe the url,
  // and the url is exactly the fallback signal for "dialect when dbType is missing" (wiping it silently destroys the dialect evidence).
  // Merge only for db: web's payload is a user-clearable field set (clearing loginUrl must actually clear it),
  // and a blanket merge would resurrect cleared fields.
  const merged = patch.payload !== undefined && existing.objectType === 'db'
    ? mergeDbPayload(prev, patch.payload)
    : patch.payload;
  const payload = merged !== undefined
    ? normalizeObjectPayload(existing.objectType as ObjectType, merged, prev)
    : undefined;
  if (payload !== undefined && existing.objectType === 'web') {
    await assertWebPayload(db, existing.environmentId, payload, objectId);
  }
  if (payload !== undefined && existing.objectType === 'db') {
    assertDbPayload(payload);
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

/** Tool set_secret: replaces payload.secret (encrypted) directly, leaving every other field untouched. Returns the masked row. */
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

/** Locates an object by (environmentId, objectType, label) (used by the set_secret tool). Returns the raw row (ciphertext included). */
export async function findEnvironmentObject(environmentId: string, objectType: ObjectType, label?: string) {
  const row = (await db.select().from(environmentObjects)
    .where(and(eq(environmentObjects.environmentId, environmentId), eq(environmentObjects.objectType, objectType), eq(environmentObjects.label, label ?? '默认')))
    .limit(1))[0];
  return row ?? null;
}
