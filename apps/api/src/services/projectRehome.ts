/**
 * 「挂载 = 搬家」：把项目搬进目标产品线时，项目的组织也随之改写成该产品线的组织。
 *
 * P0 阶段 projects.organization_id 还在（NOT NULL），但它的语义已从
 * 「项目自有组织」变成「由产品线推导的冗余快照」——本服务是唯一改写它的地方。
 * P1 删列后本服务只剩标签迁移这一步。
 *
 * 标签是组织级资源（tags.organization_id + 组织内同名唯一），case_tags 直接指向 tag 行。
 * 项目换组织后旧 tag 仍挂在源组织下：assertTagsBelongToOrg 会以 tag_org_mismatch
 * 拒绝任何带标签的用例更新，GET /projects/:id/tags 也只返回新组织的 tag，
 * 用户表现为「挂完标签全没了」。所以搬家的同时必须把标签按同名迁到目标组织。
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { caseTags, groups, projects, tags, testCases } from '../db/schema.js';
import { cache } from '../lib/cache.js';
import { tagsKey } from '../lib/cache-keys.js';

/** 项目当前组织 id；项目不存在返回 null。 */
export async function resolveProjectOrganizationId(projectId: string): Promise<string | null> {
  const row = (await db
    .select({ organizationId: projects.organizationId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1))[0];
  return row?.organizationId ?? null;
}

/** 项目当前归属的产品线 id；未归线返回 null。 */
export async function resolveProjectProductLineId(projectId: string): Promise<string | null> {
  const row = (await db
    .select({ productLineId: projects.productLineId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1))[0];
  return row?.productLineId ?? null;
}

/**
 * 把项目搬到 targetOrgId 下的 productLineId：
 * 迁移标签 → 改写 projects.organization_id / product_line_id → 双侧标签缓存失效。
 * 同组织迁移也要走（标签可能已经在目标组织，无需新建，但要去重）。
 */
export async function rehomeProjectToProductLine(
  projectId: string,
  productLineId: string,
  targetOrgId: string,
): Promise<void> {
  const sourceOrgId = await resolveProjectOrganizationId(projectId);
  if (sourceOrgId === targetOrgId) {
    // 组织没变：标签本就可用，只需改归属。
    await db.update(projects).set({ productLineId, updatedAt: new Date() }).where(eq(projects.id, projectId));
    return;
  }
  await migrateCaseTagsToOrg(projectId, targetOrgId);
  await db
    .update(projects)
    .set({ productLineId, organizationId: targetOrgId, updatedAt: new Date() })
    .where(eq(projects.id, projectId));
  // 源组织侧也失效：迁走的是该项目在源组织里可见的一批 tag，源组织的 tag 列表读的是同一张表。
  await cache.del(tagsKey(sourceOrgId!));
  await cache.del(tagsKey(targetOrgId));
}

/**
 * 把项目下所有用例挂的 tag 迁到 targetOrgId：
 * 目标组织按同名找 tag（找到复用，找不到按同名同色新建），然后重写 case_tags。
 * case_tags 主键是 (case_id, tag_id)，重写需去重——同一用例可能同时有新旧两个同名 tag。
 */
async function migrateCaseTagsToOrg(projectId: string, targetOrgId: string): Promise<void> {
  const links = await db
    .select({ caseId: caseTags.caseId, tagId: caseTags.tagId, name: tags.name, color: tags.color })
    .from(caseTags)
    .innerJoin(testCases, eq(testCases.id, caseTags.caseId))
    .innerJoin(groups, eq(groups.id, testCases.groupId))
    .innerJoin(tags, eq(tags.id, caseTags.tagId))
    .where(eq(groups.projectId, projectId));
  if (links.length === 0) return;

  // 目标组织已有的同名 tag 优先复用（避免与既有标签撞唯一约束）。
  const names = [...new Set(links.map((l) => l.name))];
  const existing = await db.select().from(tags).where(and(eq(tags.organizationId, targetOrgId), inArray(tags.name, names)));
  const byName = new Map(existing.map((t) => [t.name, t]));
  const toCreate = names.filter((n) => !byName.has(n));
  if (toCreate.length > 0) {
    const colorOf = new Map(links.map((l) => [l.name, l.color]));
    const created = await db
      .insert(tags)
      .values(toCreate.map((name) => ({ organizationId: targetOrgId, name, color: colorOf.get(name)! })))
      .returning();
    for (const t of created) byName.set(t.name, t);
  }

  const oldTagIds = [...new Set(links.map((l) => l.tagId))];
  await db.delete(caseTags).where(inArray(caseTags.tagId, oldTagIds));
  const nextRows = [...new Map(links.map((l) => [`${l.caseId}:${byName.get(l.name)!.id}`, {
    caseId: l.caseId,
    tagId: byName.get(l.name)!.id,
  }])).values()];
  if (nextRows.length > 0) await db.insert(caseTags).values(nextRows);
}