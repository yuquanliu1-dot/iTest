/**
 * 「把项目挂进某条产品线」：改写归属 + 迁移标签。
 *
 * R2 起 projects 已无 organization_id，「项目随产品线走」是数据库层面的结构不变式，
 * 所以本服务不再改写组织、也不再缓存失效——移动整条线由 productLineMove.ts 独立承担，
 * 本函数只负责「挂到另一条线」（同组织换线也算一次搬家：标签可能要按同名去重）。
 *
 * 标签是组织级资源（tags.organization_id + 组织内同名唯一），case_tags 直接指向 tag 行。
 * 项目换线后旧 tag 若不属于新线所属组织，会让 assertTagsBelongToOrg 以 tag_org_mismatch
 * 拒绝任何带标签的用例更新，GET /projects/:id/tags 也只返回新组织的 tag，
 * 用户表现为「挂完标签全没了」。所以挂载时必须把标签按同名迁到目标组织。
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { caseTags, groups, productLines, projects, tags, testCases } from '../db/schema.js';
import { cache } from '../lib/cache.js';
import { tagsKey } from '../lib/cache-keys.js';

/** 事务句柄与 db 同形（两者 query 能力一致），默认走全局 db。 */
type Tx = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete'>;

/** 项目当前归属的产品线 id；未归线返回 null（仅迁移前/历史数据可能命中）。 */
export async function resolveProjectProductLineId(projectId: string): Promise<string | null> {
  const row = (await db
    .select({ productLineId: projects.productLineId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1))[0];
  return row?.productLineId ?? null;
}

/** 产品线所属组织 id；产品线不存在返回 null。 */
async function resolveProductLineOrgId(productLineId: string): Promise<string | null> {
  const row = (await db
    .select({ organizationId: productLines.organizationId })
    .from(productLines)
    .where(eq(productLines.id, productLineId))
    .limit(1))[0];
  return row?.organizationId ?? null;
}

/** 把项目挂到 targetProductLineId 下：迁移标签 → 改写 product_line_id。 */
export async function attachProjectToProductLine(projectId: string, targetProductLineId: string): Promise<void> {
  const targetOrgId = await resolveProductLineOrgId(targetProductLineId);
  const sourceLineId = await resolveProjectProductLineId(projectId);
  // 目标组织待会儿随 product_line_id 一起确定，因此缓存失效要打在新旧两条线上。
  const sourceOrgId = sourceLineId ? await resolveProductLineOrgId(sourceLineId) : null;

  await migrateCaseTagsToOrg([projectId], targetOrgId!);
  await db
    .update(projects)
    .set({ productLineId: targetProductLineId, updatedAt: new Date() })
    .where(eq(projects.id, projectId));
  // 源组织侧也失效：迁走的是该项目在源组织里可见的一批 tag，源组织的 tag 列表读的是同一张表。
  if (sourceOrgId && sourceOrgId !== targetOrgId) await cache.del(tagsKey(sourceOrgId));
  await cache.del(tagsKey(targetOrgId!));
}

/**
 * 把一组项目下所有用例挂的 tag 迁到 targetOrgId：
 * 目标组织按同名找 tag（找到复用，找不到按同名同色新建），然后重写 case_tags。
 * case_tags 主键是 (case_id, tag_id)，重写需去重——同一用例可能同时有新旧两个同名 tag。
 *
 * 收下 tx 以便与归属改写同事务（移动产品线时要连线带项目一起搬，中途失败必须整体回滚）。
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

  // 目标组织已有的同名 tag 优先复用（避免与既有标签撞唯一约束）。
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