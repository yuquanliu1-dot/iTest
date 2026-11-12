/**
 * "Move a product line to another org": updates the single product_lines.organization_id row,
 * and every project in the line changes org with it — this is a structural invariant, not app-layer sync.
 *
 * But "the tail of moving house" has two more strings, both in the same transaction:
 *   1. Tags: tags are org-level resources and case_tags point directly at tag rows. Not migrating them shows up as
 *      "all tags gone and cases uneditable" (assertTagsBelongToOrg 400s with tag_org_mismatch).
 *   2. Assignment snapshots: project_assignments.organization_id is the org "at assignment time".
 *      Since R2 visibility reads product_lines.organization_id and no longer uses the snapshot as a gate,
 *      but it's still an audit snapshot; rewriting it along avoids misleading "assigned in A, project already in B" records.
 *
 * Everything writes in one transaction: once the half-migrated intermediate state (tags half-moved, ownership half-changed) gets read,
 * users see "all tags gone and cases uneditable".
 */
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { productLines, projectAssignments, projects } from '../db/schema.js';
import { cache } from '../lib/cache.js';
import { tagsKey } from '../lib/cache-keys.js';
import { migrateCaseTagsToOrg } from './projectRehome.js';

/**
 * Moves the product line to targetOrgId and rewrites the line's projects' tags and assignment snapshots along with it.
 * Same-name line conflicts are pre-checked by the caller (the move route in productLines.ts); this only writes.
 */
export async function moveProductLineToOrg(
  productLineId: string,
  sourceOrgId: string,
  targetOrgId: string,
): Promise<number> {
  const projectIds = (
    await db.select({ id: projects.id }).from(projects).where(eq(projects.productLineId, productLineId))
  ).map((p) => p.id);

  await db.transaction(async (tx) => {
    // Settle the line itself first; projects under the line need no rewrite — their org is this very column.
    await tx
      .update(productLines)
      .set({ organizationId: targetOrgId, updatedAt: new Date() })
      .where(eq(productLines.id, productLineId));
    if (projectIds.length === 0) return;

    await migrateCaseTagsToOrg(projectIds, targetOrgId, tx);
    if (sourceOrgId !== targetOrgId) {
      await tx
        .update(projectAssignments)
        .set({ organizationId: targetOrgId })
        .where(inArray(projectAssignments.projectId, projectIds));
    }
  });

  // Invalidate the source-org side too: what moved away is the set of tags the line's projects had visible in the source org, and the source org's tag list reads the same table.
  await cache.del(tagsKey(sourceOrgId));
  await cache.del(tagsKey(targetOrgId));
  return projectIds.length;
}