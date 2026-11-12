/**
 * "Attach a project to a product line": rewrite ownership + migrate tags.
 *
 * Since R2 projects no longer have organization_id; "the project follows its product line" is a database-level structural invariant.
 * So this service no longer rewrites orgs nor invalidates caches — moving a whole line is handled independently by productLineMove.ts,
 * and this function only handles "attaching to another line" (switching lines within one org is still a move: tags may need same-name dedup).
 *
 * Tags are org-level resources (tags.organization_id + same-name unique within an org); case_tags point directly at tag rows.
 * After a project switches lines, if the old tag doesn't belong to the new line's org, assertTagsBelongToOrg rejects any
 * case update carrying tags with tag_org_mismatch, and GET /projects/:id/tags only returns the new org's tags —
 * the user sees "all tags gone right after attaching". So attaching must migrate tags by name to the target org.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { caseTags, groups, productLines, projects, tags, testCases } from '../db/schema.js';
import { cache } from '../lib/cache.js';
import { tagsKey } from '../lib/cache-keys.js';

/** The tx handle shares db's shape (same query capability); defaults to the global db. */
type Tx = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete'>;

/** The project's current product line id; returns null when un-homed (only pre-migration/legacy data can hit this). */
export async function resolveProjectProductLineId(projectId: string): Promise<string | null> {
  const row = (await db
    .select({ productLineId: projects.productLineId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1))[0];
  return row?.productLineId ?? null;
}

/** The product line's owning org id; returns null when the line is missing. */
async function resolveProductLineOrgId(productLineId: string): Promise<string | null> {
  const row = (await db
    .select({ organizationId: productLines.organizationId })
    .from(productLines)
    .where(eq(productLines.id, productLineId))
    .limit(1))[0];
  return row?.organizationId ?? null;
}

/** Attaches the project under targetProductLineId: migrate tags → rewrite product_line_id. */
export async function attachProjectToProductLine(projectId: string, targetProductLineId: string): Promise<void> {
  const targetOrgId = await resolveProductLineOrgId(targetProductLineId);
  const sourceLineId = await resolveProjectProductLineId(projectId);
  // The target org gets determined together with product_line_id just below, so cache invalidation must hit both the old and new lines.
  const sourceOrgId = sourceLineId ? await resolveProductLineOrgId(sourceLineId) : null;

  await migrateCaseTagsToOrg([projectId], targetOrgId!);
  await db
    .update(projects)
    .set({ productLineId: targetProductLineId, updatedAt: new Date() })
    .where(eq(projects.id, projectId));
  // Invalidate the source-org side too: what moved away is the set of tags this project had visible in the source org, and the source org's tag list reads the same table.
  if (sourceOrgId && sourceOrgId !== targetOrgId) await cache.del(tagsKey(sourceOrgId));
  await cache.del(tagsKey(targetOrgId!));
}

/**
 * Migrates all tags attached by cases under a set of projects to targetOrgId:
 * find tags by name in the target org (reuse if found, else create with the same name/color), then rewrite case_tags.
 * case_tags' primary key is (case_id, tag_id), so the rewrite dedupes — one case may simultaneously have old and new same-name tags.
 *
 * Takes tx so it can share the transaction with the ownership rewrite (moving a product line carries its projects along; mid-way failure must roll back everything).
 */
export async function migrateCaseTagsToOrg(projectIds: string[], targetOrgId: string, tx: Tx = db): Promise<void> {
  if (projectIds.length === 0) return;
  const links = await tx
    .select({ caseId: caseTags.caseId, tagId: caseTags.tagId, name: tags.name, color: tags.color })
    .from(caseTags)
    .innerJoin(testCases, eq(testCases.id, caseTags.caseId))
    .innerJoin(groups, eq(groups.id, testCases.groupId))
    .innerJoin(tags, eq(tags.id, caseTags.tagId))
    .where(inArray(groups.projectId, projectIds));
  if (links.length === 0) return;

  // Reuse the target org's existing same-name tag first (avoids colliding with existing tags on the unique constraint).
  const names = [...new Set(links.map((l) => l.name))];
  const existing = await tx.select().from(tags).where(and(eq(tags.organizationId, targetOrgId), inArray(tags.name, names)));
  const byName = new Map(existing.map((t) => [t.name, t]));
  const toCreate = names.filter((n) => !byName.has(n));
  if (toCreate.length > 0) {
    const colorOf = new Map(links.map((l) => [l.name, l.color]));
    const created = await tx
      .insert(tags)
      .values(toCreate.map((name) => ({ organizationId: targetOrgId, name, color: colorOf.get(name)! })))
      .returning();
    for (const t of created) byName.set(t.name, t);
  }

  const oldTagIds = [...new Set(links.map((l) => l.tagId))];
  await tx.delete(caseTags).where(inArray(caseTags.tagId, oldTagIds));
  const nextRows = [...new Map(links.map((l) => [`${l.caseId}:${byName.get(l.name)!.id}`, {
    caseId: l.caseId,
    tagId: byName.get(l.name)!.id,
  }])).values()];
  if (nextRows.length > 0) await tx.insert(caseTags).values(nextRows);
}