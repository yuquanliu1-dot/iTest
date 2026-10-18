/**
 * assistant_mcp_servers 最小 CRUD（管理端，无 UI；管理 UI 归后续需求）。
 * 挂载于 /api/assistant/mcp-servers，router.ts 处 requireManager 保护。
 * 配置期守卫（spec §MCP）：exposure=oauth 及未知值一律拒绝（服务端无 loopback 回调能力）；
 * kind=stdio 必须 command；kind=http 必须 http(s):// url（防 file:// 等本地读取）。
 *
 * 可见性（与 guidesRoute 一致，经 projectAccess.ts 断言）：
 *  - scope=global 的 server 实例级共享（LoadAll 全局加载 + 管理全局可见）；
 *  - scope=project/version 的 server 归属于具体组织，仅该组织（子树）用户可见/可管理，
 *    跨组织访问一律 404（不区分「不存在」与「不可见」，防存在性探测）。
 *    注意：scope 只约束 CRUD 控制面；LOADING（loadEnabledMcpServers）刻意全局加载全部启用行。
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assistantMcpServers, projectVersions } from '../../db/schema.js';
import { HttpError } from '../../middleware/errorHandler.js';
import type { AuthUser } from '../../services/auth.service.js';
import { assertProjectVisible, assertVersionVisible, visibleProjectIds } from '../../services/projectAccess.js';

export const mcpServersRoute = Router();

const KIND = ['stdio', 'http'] as const;
const EXPOSURE = ['codemode', 'deferred', 'direct', 'hidden'] as const;
const SCOPE = ['global', 'project', 'version'] as const;

/** server 行可见性断言：global 共享；project/version 归属组织，跨组织 404。 */
async function assertMcpServerVisible(
  row: Pick<typeof assistantMcpServers.$inferSelect, 'scope' | 'projectId' | 'versionId'>,
  user: AuthUser,
): Promise<void> {
  if (row.scope === 'project') {
    if (!row.projectId) throw new HttpError(404, 'not_found', 'mcp server 不存在');
    await assertProjectVisible(row.projectId, user);
  } else if (row.scope === 'version') {
    if (!row.versionId) throw new HttpError(404, 'not_found', 'mcp server 不存在');
    await assertVersionVisible(row.versionId, user);
  }
}

mcpServersRoute.get('/', async (req, res) => {
  const user = req.user as AuthUser;
  const q = req.query;
  const conds: SQL[] = [];
  if (typeof q.kind === 'string' && q.kind) conds.push(eq(assistantMcpServers.kind, q.kind));
  if (typeof q.enabled === 'string') conds.push(eq(assistantMcpServers.enabled, q.enabled === 'true'));
  const rows = await db.select().from(assistantMcpServers).where(and(...conds)).orderBy(asc(assistantMcpServers.name));
  // 可见性过滤：global 全量返回；project/version 只在可见项目内返回（一次查可见项目 + 一次 version→project 归并，避免逐行断言）
  const visible = new Set(await visibleProjectIds(user));
  const versionRows = rows.filter((r) => r.scope === 'version' && r.versionId != null);
  const versionProject = new Map<string, string>();
  if (versionRows.length > 0) {
    const vp = await db
      .select({ versionId: projectVersions.id, projectId: projectVersions.projectId })
      .from(projectVersions)
      .where(inArray(projectVersions.id, versionRows.map((r) => r.versionId as string)));
    for (const v of vp) versionProject.set(v.versionId, v.projectId);
  }
  const filtered = rows.filter((r) => {
    if (r.scope === 'project') return r.projectId != null && visible.has(r.projectId);
    if (r.scope === 'version') {
      const pid = r.versionId ? versionProject.get(r.versionId) : undefined;
      return pid != null && visible.has(pid);
    }
    return true; // global：实例级共享
  });
  res.json(filtered);
});

mcpServersRoute.post('/', async (req, res) => {
  const user = req.user as AuthUser;
  const b = req.body as Record<string, unknown>;
  const kind = (b.kind as string) ?? 'stdio';
  if (!KIND.includes(kind as never)) throw new HttpError(400, 'bad_request', 'kind 必须是 stdio|http');
  const exposure = (b.exposure as string) ?? 'codemode';
  if (!EXPOSURE.includes(exposure as never)) {
    throw new HttpError(400, 'bad_request', `exposure 必须是 ${EXPOSURE.join('|')}（oauth 不支持——服务端无 loopback 回调）`);
  }
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : null;
  if (!name) throw new HttpError(400, 'bad_request', 'name 必填');
  // scope=project/version 归属组织：跨组织 404 且必须在插入前断言（与 guidesRoute 同语义）
  const scope = (b.scope as string) ?? 'global';
  if (!SCOPE.includes(scope as never)) throw new HttpError(400, 'bad_request', 'scope 必须是 global|project|version');
  if (scope === 'project') {
    if (typeof b.projectId !== 'string') throw new HttpError(400, 'bad_request', 'scope=project 需要 projectId');
    await assertProjectVisible(b.projectId, user);
  }
  if (scope === 'version') {
    if (typeof b.versionId !== 'string') throw new HttpError(400, 'bad_request', 'scope=version 需要 versionId');
    await assertVersionVisible(b.versionId, user);
  }
  if (kind === 'stdio' && (typeof b.command !== 'string' || !b.command.trim())) {
    throw new HttpError(400, 'bad_request', 'kind=stdio 需要 command');
  }
  if (kind === 'http' && (typeof b.url !== 'string' || !/^https?:\/\//.test(b.url))) {
    throw new HttpError(400, 'bad_request', 'kind=http 需要 http(s):// url');
  }
  const rows = await db.insert(assistantMcpServers).values({
    id: randomUUID(),
    name,
    kind,
    command: kind === 'stdio' ? (b.command as string).trim() : null,
    args: kind === 'stdio' ? (Array.isArray(b.args) ? (b.args as string[]) : []) : null,
    url: kind === 'http' ? (b.url as string) : null,
    env: b.env && typeof b.env === 'object' ? (b.env as Record<string, string>) : null,
    exposure,
    scope,
    projectId: scope === 'project' ? (b.projectId as string) : null,
    versionId: scope === 'version' ? (b.versionId as string) : null,
    enabled: b.enabled === false ? false : true,
  }).returning();
  res.status(201).json(rows[0]);
});

mcpServersRoute.patch('/:id', async (req, res) => {
  const user = req.user as AuthUser;
  // PATCH 先载旧行并断言可见性（跨组织 404），再校验/套用 diff（与 guidesRoute 同语义）
  const existing = (await db.select().from(assistantMcpServers).where(eq(assistantMcpServers.id, req.params.id)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'mcp server 不存在');
  await assertMcpServerVisible(existing, user);
  const patch: Partial<typeof assistantMcpServers.$inferInsert> = {};
  const p = req.body as Record<string, unknown>;
  if ('name' in p) {
    if (typeof p.name !== 'string' || !p.name.trim()) throw new HttpError(400, 'bad_request', 'name 必填');
    patch.name = p.name.trim();
  }
  if ('kind' in p) {
    const kind = p.kind as string;
    if (!KIND.includes(kind as never)) throw new HttpError(400, 'bad_request', 'kind 必须是 stdio|http');
    patch.kind = kind;
    if (kind === 'stdio' && (typeof p.command !== 'string' || !p.command.trim())) {
      throw new HttpError(400, 'bad_request', 'kind=stdio 需要 command');
    }
    if (kind === 'http' && (typeof p.url !== 'string' || !/^https?:\/\//.test(p.url))) {
      throw new HttpError(400, 'bad_request', 'kind=http 需要 http(s):// url');
    }
  } else {
    if ('command' in p) {
      if (typeof p.command !== 'string' || !p.command.trim()) throw new HttpError(400, 'bad_request', 'command 必填');
      patch.command = p.command.trim();
    }
    if ('url' in p) {
      if (typeof p.url !== 'string' || !/^https?:\/\//.test(p.url)) throw new HttpError(400, 'bad_request', 'kind=http 需要 http(s):// url');
      patch.url = p.url;
    }
  }
  if ('args' in p) patch.args = Array.isArray(p.args) ? (p.args as string[]) : undefined;
  if ('env' in p) patch.env = p.env && typeof p.env === 'object' ? (p.env as Record<string, string>) : undefined;
  if ('exposure' in p) {
    const exp = p.exposure as string;
    if (!EXPOSURE.includes(exp as never)) throw new HttpError(400, 'bad_request', `exposure 必须是 ${EXPOSURE.join('|')}（oauth 不支持）`);
    patch.exposure = exp;
  }
  // 改 scope 到 project/version 必须在同一次 PATCH 里给对应 id，否则落入陈旧 id（POST 语义一致）
  if ('scope' in p) {
    const scope = p.scope as string;
    if (!SCOPE.includes(scope as never)) throw new HttpError(400, 'bad_request', 'scope 必须是 global|project|version');
    if (scope === 'project' && typeof p.projectId !== 'string') throw new HttpError(400, 'bad_request', '改 scope=project 需要同时给 projectId');
    if (scope === 'version' && typeof p.versionId !== 'string') throw new HttpError(400, 'bad_request', '改 scope=version 需要同时给 versionId');
    patch.scope = scope;
    patch.projectId = scope === 'project' ? (p.projectId as string) : null;
    patch.versionId = scope === 'version' ? (p.versionId as string) : null;
  } else {
    if ('projectId' in p) patch.projectId = typeof p.projectId === 'string' ? (p.projectId as string) : null;
    if ('versionId' in p) patch.versionId = typeof p.versionId === 'string' ? (p.versionId as string) : null;
  }
  if ('enabled' in p) patch.enabled = p.enabled === false ? false : true;
  // 生效后 scope 的可见性：新给/沿用的 project/version id 都必须指向可见项目
  const effScope = (patch.scope as string | undefined) ?? existing.scope;
  if (effScope === 'project') {
    const pid = patch.projectId !== undefined ? (patch.projectId as string | null) : existing.projectId;
    if (!pid) throw new HttpError(400, 'bad_request', 'scope=project 需要 projectId');
    await assertProjectVisible(pid, user);
  } else if (effScope === 'version') {
    const vid = patch.versionId !== undefined ? (patch.versionId as string | null) : existing.versionId;
    if (!vid) throw new HttpError(400, 'bad_request', 'scope=version 需要 versionId');
    await assertVersionVisible(vid, user);
  }
  const updated = await db.update(assistantMcpServers)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(assistantMcpServers.id, req.params.id))
    .returning();
  if (updated.length === 0) throw new HttpError(404, 'not_found', 'mcp server 不存在');
  res.json(updated[0]);
});

mcpServersRoute.delete('/:id', async (req, res) => {
  const user = req.user as AuthUser;
  // 先载旧行并断言可见性（跨组织 404），再删除（与 guidesRoute 同语义）
  const existing = (await db.select().from(assistantMcpServers).where(eq(assistantMcpServers.id, req.params.id)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'mcp server 不存在');
  await assertMcpServerVisible(existing, user);
  const deleted = await db.delete(assistantMcpServers)
    .where(eq(assistantMcpServers.id, req.params.id))
    .returning();
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'mcp server 不存在');
  res.status(204).end();
});