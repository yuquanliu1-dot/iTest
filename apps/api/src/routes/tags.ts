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

// HEX 颜色：可带 # 前缀，最长 16 字符（库列宽）
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
  // 存库统一为无 `#` 小写；前端 chip 直接 `#{color}`
  return raw.replace(/^#/, '').toLowerCase();
}

/** 解析 project → 所属 org id（经 product_lines）；找不到抛 404。 */
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

/** GET /api/projects/:projectId/tags — 列出「项目所属组织」下的全部 tag。
 *  组织级共享：同 org 下所有项目可见全员 tag。
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

/** PATCH /:tagId — 按 tagId 找 tag；要求 tag 所属组织对当前用户可见。
 *  名字唯一性仅在 tag 所在 org 内判定。
 */
tagsRoute.patch('/:tagId', async (req, res) => {
  const { tagId } = req.params as { projectId: string; tagId: string };
  if (!tagId) throw new HttpError(400, 'bad_request', 'tagId required');
  const body = PatchBody.parse(req.body);
  const existing = await db.select().from(tags).where(eq(tags.id, tagId)).limit(1);
  const row = existing[0];
  if (!row) throw new HttpError(404, 'not_found', 'tag not found');
  // 验证 tag 所在组织对当前用户可见
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

/** DELETE /:tagId — 同样按 tagId + org 可见性校验。
 *  onDelete cascade 会自动解除 caseTags。
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

// 仅在同模块内被引用；保持 PG 唯一冲突识别简单
function isUniqueViolation(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const code = (e as { code?: string }).code;
  return code === '23505';
}

// 静默引用，保留项目类型解析路径
void projects;
void organizations;
void inArray;
