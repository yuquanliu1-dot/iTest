import { Router } from 'express';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tags, caseTags, projects } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { assertProjectVisible } from '../services/projectAccess.js';

// HEX 颜色：可带 # 前缀，最长 16 字符（库列宽）
const hexColor = z.string().regex(/^#?[0-9a-fA-F]{3,8}$/, 'invalid hex color').max(16);

const CreateBody = z.object({
  name: z.string().min(1).max(80),
  color: hexColor,
  description: z.string().max(500).optional(),
});
const PatchBody = z.object({
  name: z.string().min(1).max(80).optional(),
  color: hexColor.optional(),
  description: z.string().max(500).optional(),
});

function normalizeColor(raw: string): string {
  // 存库统一为无 `#` 小写；前端 chip 直接 `#{color}`
  return raw.replace(/^#/, '').toLowerCase();
}

export const tagsRoute = Router({ mergeParams: true });

tagsRoute.get('/', async (req, res) => {
  const { projectId } = req.params as { projectId: string };
  if (!projectId) throw new HttpError(400, 'bad_request', 'projectId required');
  await assertProjectVisible(projectId, req.user!);
  const rows = await db.select().from(tags).where(eq(tags.projectId, projectId)).orderBy(tags.name);
  res.json(rows);
});

tagsRoute.post('/', async (req, res) => {
  const { projectId } = req.params as { projectId: string };
  if (!projectId) throw new HttpError(400, 'bad_request', 'projectId required');
  const body = CreateBody.parse(req.body);
  await assertProjectVisible(projectId, req.user!);
  try {
    const rows = await db
      .insert(tags)
      .values({ projectId, name: body.name, color: normalizeColor(body.color), description: body.description ?? null })
      .returning();
    res.json(rows[0]);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'tag_name_conflict', `tag "${body.name}" already exists`);
    throw e;
  }
});

tagsRoute.patch('/:tagId', async (req, res) => {
  const { projectId, tagId } = req.params as { projectId: string; tagId: string };
  if (!projectId || !tagId) throw new HttpError(400, 'bad_request', 'projectId/tagId required');
  const body = PatchBody.parse(req.body);
  await assertProjectVisible(projectId, req.user!);
  const update: Partial<{ name: string; color: string; description: string | null }> = {};
  if (body.name !== undefined) update.name = body.name;
  if (body.color !== undefined) update.color = normalizeColor(body.color);
  if (body.description !== undefined) update.description = body.description ?? null;
  if (Object.keys(update).length === 0) {
    const row = (await db.select().from(tags).where(and(eq(tags.id, tagId), eq(tags.projectId, projectId))))[0];
    if (!row) throw new HttpError(404, 'not_found', 'tag not found');
    res.json(row);
    return;
  }
  update as { updatedAt?: Date };
  try {
    const rows = await db
      .update(tags)
      .set({ ...update, updatedAt: new Date() })
      .where(and(eq(tags.id, tagId), eq(tags.projectId, projectId)))
      .returning();
    if (rows.length === 0) throw new HttpError(404, 'not_found', 'tag not found');
    res.json(rows[0]);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'tag_name_conflict', `tag "${body.name}" already exists`);
    throw e;
  }
});

tagsRoute.delete('/:tagId', async (req, res) => {
  const { projectId, tagId } = req.params as { projectId: string; tagId: string };
  if (!projectId || !tagId) throw new HttpError(400, 'bad_request', 'projectId/tagId required');
  await assertProjectVisible(projectId, req.user!);
  // caseTags 上的外键级联解除（onDelete: 'cascade'）。
  const rows = await db
    .delete(tags)
    .where(and(eq(tags.id, tagId), eq(tags.projectId, projectId)))
    .returning({ id: tags.id });
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'tag not found');
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
