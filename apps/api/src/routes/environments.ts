import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { testEnvironments, testCases, executionPlans } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';
import { encrypt } from '../lib/secret-crypto.js';
import { assertProjectVisible, assertEnvironmentVisible } from '../services/projectAccess.js';

export const environmentsRoute = Router();

const MASK = '••••••••';
const SECRET_KEYS = [
  'db_password_ciphertext', 'db_password_iv', 'db_password_tag',
  'syslog_key_ciphertext', 'syslog_key_iv', 'syslog_key_tag',
] as const;

function maskSecrets(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const k of SECRET_KEYS) if (out[k]) out[k] = MASK;
  return out;
}

environmentsRoute.get('/projects/:projectId/environments', async (req, res) => {
  const projectId = (req.params as { projectId: string }).projectId;
  await assertProjectVisible(projectId, req.user!);
  const rows = await db
    .select()
    .from(testEnvironments)
    .where(eq(testEnvironments.projectId, projectId))
    .orderBy(testEnvironments.createdAt);
  res.json(rows.map((r) => maskSecrets({ ...r })));
});

const EnvBody = z.object({
  name: z.string().min(1).max(120),
  dbHost: z.string().max(200).optional(),
  dbPort: z.number().int().min(1).max(65535).optional(),
  dbName: z.string().max(120).optional(),
  dbUser: z.string().max(120).optional(),
  dbPassword: z.string().max(500).optional(),
  syslogHost: z.string().max(200).optional(),
  syslogUser: z.string().max(120).optional(),
  syslogSshPort: z.number().int().min(1).max(65535).optional(),
  syslogKey: z.string().max(8000).optional(),
  syslogFilePath: z.string().max(500).optional(),
});

environmentsRoute.post('/projects/:projectId/environments', async (req, res) => {
  const projectId = (req.params as { projectId: string }).projectId;
  await assertProjectVisible(projectId, req.user!);
  const body = EnvBody.parse(req.body);
  const dbPwd = body.dbPassword ? encrypt(body.dbPassword) : null;
  const sshKey = body.syslogKey ? encrypt(body.syslogKey) : null;
  const inserted = await db.insert(testEnvironments).values({
    projectId,
    name: body.name,
    dbHost: body.dbHost ?? null,
    dbPort: body.dbPort ?? null,
    dbName: body.dbName ?? null,
    dbUser: body.dbUser ?? null,
    dbPasswordCiphertext: dbPwd?.ciphertext.toString('base64') ?? null,
    dbPasswordIv: dbPwd?.iv.toString('base64') ?? null,
    dbPasswordTag: dbPwd?.tag.toString('base64') ?? null,
    syslogHost: body.syslogHost ?? null,
    syslogUser: body.syslogUser ?? null,
    syslogSshPort: body.syslogSshPort ?? null,
    syslogKeyCiphertext: sshKey?.ciphertext.toString('base64') ?? null,
    syslogKeyIv: sshKey?.iv.toString('base64') ?? null,
    syslogKeyTag: sshKey?.tag.toString('base64') ?? null,
    syslogFilePath: body.syslogFilePath ?? null,
  }).returning();
  res.json(maskSecrets({ ...inserted[0]! }));
});

const EnvPatchBody = EnvBody.partial();

environmentsRoute.patch('/environments/:id', async (req, res) => {
  const { projectId } = await assertEnvironmentVisible(req.params.id!, req.user!);
  const body = EnvPatchBody.parse(req.body);
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name !== undefined) update.name = body.name;
  if (body.dbHost !== undefined) update.dbHost = body.dbHost;
  if (body.dbPort !== undefined) update.dbPort = body.dbPort;
  if (body.dbName !== undefined) update.dbName = body.dbName;
  if (body.dbUser !== undefined) update.dbUser = body.dbUser;
  if (body.syslogHost !== undefined) update.syslogHost = body.syslogHost;
  if (body.syslogUser !== undefined) update.syslogUser = body.syslogUser;
  if (body.syslogSshPort !== undefined) update.syslogSshPort = body.syslogSshPort;
  if (body.syslogFilePath !== undefined) update.syslogFilePath = body.syslogFilePath;
  if (body.dbPassword) {
    const e = encrypt(body.dbPassword);
    update.dbPasswordCiphertext = e.ciphertext.toString('base64');
    update.dbPasswordIv = e.iv.toString('base64');
    update.dbPasswordTag = e.tag.toString('base64');
  }
  if (body.syslogKey) {
    const e = encrypt(body.syslogKey);
    update.syslogKeyCiphertext = e.ciphertext.toString('base64');
    update.syslogKeyIv = e.iv.toString('base64');
    update.syslogKeyTag = e.tag.toString('base64');
  }
  await db.update(testEnvironments).set(update).where(and(eq(testEnvironments.id, req.params.id), eq(testEnvironments.projectId, projectId)));
  const row = (await db.select().from(testEnvironments).where(eq(testEnvironments.id, req.params.id)))[0];
  res.json(maskSecrets({ ...row! }));
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

environmentsRoute.get('/environments/allowed-tables', async (_req, res) => {
  const { ALLOWED_QUERY_COLUMNS } = await import('../execute/dbQuery.js');
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(ALLOWED_QUERY_COLUMNS)) out[k] = Array.from(v);
  res.json(out);
});
