/**
 * 「移动产品线到另一个组织」：改 product_lines.organization_id 一行，
 * 线内全部项目跟着换组织——这是结构不变式，不是应用层同步。
 *
 * 但「搬家的尾巴」还有两串，都必须同事务：
 *   1. 标签：tags 是组织级资源，case_tags 直接指向 tag 行。不迁就表现为
 *      「标签全没了且用例改不动」（assertTagsBelongToOrg 以 tag_org_mismatch 400）。
 *   2. 分配快照：project_assignments.organization_id 是「分配发生时」的组织。
 *      R2 起可见性已改走 product_lines.organization_id，不再拿快照当闸门，
 *      但它仍是给审计看的快照，跟随改写可免得留下「分配在 A、项目已在 B」的误导性记录。
 *
 * 全部写在一个事务里：标签迁了一半、归属改了一半的中间态一旦被读到，用户会看到
 * 「标签全没了且用例改不动」。
 */
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { productLines, projectAssignments, projects } from '../db/schema.js';
import { cache } from '../lib/cache.js';
import { tagsKey } from '../lib/cache-keys.js';
import { migrateCaseTagsToOrg } from './projectRehome.js';

/**
 * 把产品线搬到 targetOrgId，并连带改写线内项目的标签与分配快照。
 * 同名线冲突由调用方预检（productLines.ts 的 move 路由），这里只做写。
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
    // 线本身先落定；线下项目无需改写——它们的组织就是这一列。
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

  // 源组织侧也失效：迁走的是线内项目在源组织里可见的一批 tag，源组织的 tag 列表读的是同一张表。
  await cache.del(tagsKey(sourceOrgId));
  await cache.del(tagsKey(targetOrgId));
  return projectIds.length;
}