import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { testCases, testSteps, groups } from '../db/schema.js';
import { eq, asc, inArray } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';
import { resolveCaseUrl } from '../lib/resolve-url.js';
import { assertCaseVisible, assertProjectVisible, visibleProjectIds } from '../services/projectAccess.js';

export const casesRoute = Router();

const CaseBodyBase = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).default('P1'),
  requirementId: z.string().uuid().optional(),
  groupId: z.string().uuid(),
  url: z.string().optional(),
  windowStrategy: z.enum(['maximize', 'current', 'custom']).default('maximize'),
  windowWidth: z.number().int().min(200).max(10000).optional(),
  windowHeight: z.number().int().min(200).max(10000).optional(),
  incognito: z.boolean().default(false),
});

function checkWindowStrategy(
  val: { windowStrategy?: string; windowWidth?: number; windowHeight?: number },
  ctx: z.RefinementCtx,
): void {
  if (val.windowStrategy === 'custom' && (!val.windowWidth || !val.windowHeight)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['windowWidth'],
      message: 'windowWidth and windowHeight are required when windowStrategy is custom',
    });
  }
}

const CreateBody = CaseBodyBase.superRefine(checkWindowStrategy);
const PatchBody = CaseBodyBase.partial().superRefine(checkWindowStrategy);

casesRoute.get('/', async (req, res) => {
  const { priority, groupId, projectId } = req.query as Record<string, string | undefined>;
  let rows;
  if (projectId) {
    await assertProjectVisible(projectId, req.user!);
    const gs = await db.select().from(groups).where(eq(groups.projectId, projectId));
    const gids = gs.map((g) => g.id);
    rows = gids.length
      ? await db.select().from(testCases).where(inArray(testCases.groupId, gids))
      : [];
  } else if (groupId) {
    const g = await db.select().from(groups).where(eq(groups.id, groupId)).limit(1);
    if (!g[0]) throw new HttpError(404, 'not_found', 'group not found');
    await assertProjectVisible(g[0].projectId, req.user!);
    rows = await db.select().from(testCases).where(eq(testCases.groupId, groupId));
  } else {
    // 无参分支：按可见项目过滤
    const visiblePids = await visibleProjectIds(req.user!);
    const gs = visiblePids.length
      ? await db.select().from(groups).where(inArray(groups.projectId, visiblePids))
      : [];
    const gids = gs.map((g) => g.id);
    rows = gids.length
      ? await db.select().from(testCases).where(inArray(testCases.groupId, gids))
      : [];
  }
  if (priority) rows = rows.filter((r) => r.priority === priority);
  res.json(rows);
});

casesRoute.post('/', async (req, res) => {
  const body = CreateBody.parse(req.body);
  const g = await db.select().from(groups).where(eq(groups.id, body.groupId));
  if (g.length === 0) throw new HttpError(404, 'not_found', 'group not found');
  await assertProjectVisible(g[0]!.projectId, req.user!);
  const rows = await db.insert(testCases).values(body).returning();
  res.json(rows[0]);
});

casesRoute.get('/:id', async (req, res) => {
  await assertCaseVisible(req.params.id!, req.user!);
  const rows = await db.select().from(testCases).where(eq(testCases.id, req.params.id));
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  const steps = await db
    .select()
    .from(testSteps)
    .where(eq(testSteps.caseId, req.params.id))
    .orderBy(asc(testSteps.order));
  // Redact secret material from the GET response; the recorder uses the dedicated
  // /steps/secrets/:stepId endpoint with the ws token to retrieve plaintext at execution time.
  const sanitizedSteps = steps.map(({ secretCiphertext: _sc, secretIv: _si, secretTag: _st, ...rest }) => rest);
  const resolvedUrl = await resolveCaseUrl(rows[0]!);
  res.json({ ...rows[0], steps: sanitizedSteps, resolvedUrl });
});

casesRoute.patch('/:id', async (req, res) => {
  const body = PatchBody.parse(req.body);
  await assertCaseVisible(req.params.id!, req.user!);
  if (body.groupId) {
    // 移动目标分组也必须可见
    const g = await db.select().from(groups).where(eq(groups.id, body.groupId));
    if (g.length === 0) throw new HttpError(404, 'not_found', 'group not found');
    await assertProjectVisible(g[0]!.projectId, req.user!);
  }
  const rows = await db
    .update(testCases)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(testCases.id, req.params.id))
    .returning();
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  res.json(rows[0]);
});

async function nextCopyTitle(base: string, existing: string[]): Promise<string> {
  const taken = new Set(existing);
  const first = `${base} 副本`;
  if (!taken.has(first)) return first;
  let n = 1;
  while (taken.has(`${base} 副本${n}`)) n++;
  return `${base} 副本${n}`;
}

async function copyOneCase(caseId: string, targetGroupId: string, user: NonNullable<Express.Request['user']>): Promise<unknown> {
  const src = (await db.select().from(testCases).where(eq(testCases.id, caseId)))[0];
  if (!src) throw new HttpError(404, 'not_found', 'case not found');
  // 源 case 与目标分组所在项目都必须可见
  await assertCaseVisible(caseId, user);
  const targetGroup = (await db.select().from(groups).where(eq(groups.id, targetGroupId)))[0];
  if (targetGroup) await assertProjectVisible(targetGroup.projectId, user);
  const siblings = await db.select({ title: testCases.title }).from(testCases).where(eq(testCases.groupId, targetGroupId));
  const title = await nextCopyTitle(src.title, siblings.map((s) => s.title));
  const steps = await db
    .select()
    .from(testSteps)
    .where(eq(testSteps.caseId, caseId))
    .orderBy(asc(testSteps.order));
  const inserted = await db
    .insert(testCases)
    .values({
      title,
      description: src.description,
      priority: src.priority,
      groupId: targetGroupId,
      url: src.url,
    })
    .returning();
  const newCase = inserted[0]!;
  if (steps.length > 0) {
    await db.insert(testSteps).values(
      steps.map((s) => ({
        caseId: newCase.id,
        order: s.order,
        source: s.source,
        action: s.action,
        assertion: s.assertion,
      })),
    );
  }
  return newCase;
}

casesRoute.post('/:id/copy', async (req, res) => {
  const body = z.object({ targetGroupId: z.string().uuid() }).parse(req.body);
  const g = await db.select().from(groups).where(eq(groups.id, body.targetGroupId));
  if (g.length === 0) throw new HttpError(404, 'not_found', 'group not found');
  await assertProjectVisible(g[0]!.projectId, req.user!);
  res.json(await copyOneCase(req.params.id!, body.targetGroupId, req.user!));
});

casesRoute.post('/copy', async (req, res) => {
  const body = z.object({ caseIds: z.array(z.string().uuid()).min(1), targetGroupId: z.string().uuid() }).parse(req.body);
  const g = await db.select().from(groups).where(eq(groups.id, body.targetGroupId));
  if (g.length === 0) throw new HttpError(404, 'not_found', 'group not found');
  await assertProjectVisible(g[0]!.projectId, req.user!);
  for (const id of body.caseIds) {
    await copyOneCase(id, body.targetGroupId, req.user!);
  }
  res.json({ count: body.caseIds.length });
});

casesRoute.delete('/:id', async (req, res) => {
  await assertCaseVisible(req.params.id!, req.user!);
  const deleted = await db.delete(testCases).where(eq(testCases.id, req.params.id)).returning();
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  res.json({ ok: true });
});
