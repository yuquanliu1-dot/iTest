import { Router } from 'express';
import { z } from 'zod';
import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tags, projects, productLines, organizations } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { assertProjectVisible } from '../services/projectAccess.js';
import { visibleOrgIdsFor } from '../services/orgTree.js';
import { cache, wrap } from '../lib/cache.js';
import { tagsKey } from '../lib/cache-keys.js';

// HEX color: may carry a # prefix, max 16 chars (DB column width)
const hexColor = z.string().regex(/^#?[0-9a-fA-F]{3,8}$/, 'invalid hex color').max(16);

const CreateBody = z.object({
  name: z.string().min(1).max(80),
  color: hexColor,
  description: z.string().max(500).nullable().optional(),
});
const PatchBody = z.object({
  name: z.string().min(1).max(80).optional(),
  color: hexColor.optional(),
  description: z.string().max(500).nullable().optional(),
});

function normalizeColor(raw: string): string {
  // Stored in the DB uniformly as lowercase without `#`; the frontend chip uses `#{color}` directly
  return raw.replace(/^#/, '').toLowerCase();
}

/** Resolve project → owning org id (via product_lines); throws 404 when not found. */
async function resolveOrgIdForProject(projectId: string): Promise<string> {
  const rows = await db
    .select({ organizationId: productLines.organizationId })
    .from(projects)
    .innerJoin(productLines, eq(productLines.id, projects.productLineId))
    .where(eq(projects.id, projectId))
    .limit(1);
  const orgId = rows[0]?.organizationId;
  if (!orgId) throw new HttpError(404, 'not_found', 'project not found');
  return orgId;
}

export const tagsRoute = Router({ mergeParams: true });

/** GET /api/projects/:projectId/tags — list all tags under the project's owning org.
 *  Org-level sharing: every project in the same org sees the org-wide tags.
 */
tagsRoute.get('/', async (req, res) => {
  const { projectId } = req.params as { projectId: string };
  if (!projectId) throw new HttpError(400, 'bad_request', 'projectId required');
  await assertProjectVisible(projectId, req.user!);
  const orgId = await resolveOrgIdForProject(projectId);
  const rows = await wrap(tagsKey(orgId), 5 * 60_000, async () => {
    return db.select().from(tags).where(eq(tags.organizationId, orgId)).orderBy(tags.name);
  });
  res.json(rows);
});

tagsRoute.post('/', async (req, res) => {
  const { projectId } = req.params as { projectId: string };
  if (!projectId) throw new HttpError(400, 'bad_request', 'projectId required');
  const body = CreateBody.parse(req.body);
  await assertProjectVisible(projectId, req.user!);
  const orgId = await resolveOrgIdForProject(projectId);
  try {
    const rows = await db
      .insert(tags)
      .values({ organizationId: orgId, name: body.name, color: normalizeColor(body.color), description: body.description ?? null })
      .returning();
    await cache.del(tagsKey(orgId));
    res.json(rows[0]);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'tag_name_conflict', `tag "${body.name}" already exists`);
    throw e;
  }
});

/** PATCH /:tagId — find the tag by tagId; requires the tag's org to be visible to the current user.
 *  Name uniqueness is judged only within the tag's org.
 */
tagsRoute.patch('/:tagId', async (req, res) => {
  const { tagId } = req.params as { projectId: string; tagId: string };
  if (!tagId) throw new HttpError(400, 'bad_request', 'tagId required');
  const body = PatchBody.parse(req.body);
  const existing = await db.select().from(tags).where(eq(tags.id, tagId)).limit(1);
  const row = existing[0];
  if (!row) throw new HttpError(404, 'not_found', 'tag not found');
  // Verify the tag's org is visible to the current user
  const visible = await visibleOrgIdsFor(req.user!);
  if (!visible.has(row.organizationId)) throw new HttpError(404, 'not_found', 'tag not found');

  const update: Partial<{ name: string; color: string; description: string | null }> = {};
  if (body.name !== undefined) update.name = body.name;
  if (body.color !== undefined) update.color = normalizeColor(body.color);
  if (body.description !== undefined) update.description = body.description ?? null;
  if (Object.keys(update).length === 0) {
    res.json(row);
    return;
  }
  try {
    const rows = await db
      .update(tags)
      .set({ ...update, updatedAt: new Date() })
      .where(eq(tags.id, tagId))
      .returning();
    if (rows.length === 0) throw new HttpError(404, 'not_found', 'tag not found');
    await cache.del(tagsKey(row.organizationId));
    res.json(rows[0]);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'tag_name_conflict', `tag "${body.name}" already exists`);
    throw e;
  }
});

/** DELETE /:tagId — same tagId + org visibility checks.
 *  onDelete cascade unbinds caseTags automatically.
 */
tagsRoute.delete('/:tagId', async (req, res) => {
  const { tagId } = req.params as { projectId: string; tagId: string };
  if (!tagId) throw new HttpError(400, 'bad_request', 'tagId required');
  const existing = await db.select({ organizationId: tags.organizationId }).from(tags).where(eq(tags.id, tagId)).limit(1);
  if (!existing[0]) throw new HttpError(404, 'not_found', 'tag not found');
  const visible = await visibleOrgIdsFor(req.user!);
  if (!visible.has(existing[0].organizationId)) throw new HttpError(404, 'not_found', 'tag not found');
  const rows = await db.delete(tags).where(eq(tags.id, tagId)).returning({ id: tags.id });
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'tag not found');
  await cache.del(tagsKey(existing[0].organizationId));
  res.json({ ok: true });
});

// Only referenced within this module; keeps PG unique-violation detection simple
function isUniqueViolation(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const code = (e as { code?: string }).code;
  return code === '23505';
}

// Silent references, keeping the project type-resolution path
void projects;
void organizations;
void inArray;
