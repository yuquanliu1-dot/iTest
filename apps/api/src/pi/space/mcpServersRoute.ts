/**
 * assistant_mcp_servers minimal CRUD (admin side, no UI; admin UI belongs to a later requirement).
 * Mounted at /api/assistant/mcp-servers, protected by requireManager at router.ts.
 * Config-time guards (spec §MCP): exposure=oauth and unknown values always rejected (the server has no loopback-callback capability);
 * kind=stdio must have command; kind=http must have an http(s):// url (preventing file:// and other local reads).
 *
 * Visibility (consistent with guidesRoute, asserted via projectAccess.ts):
 *  - scope=global servers are instance-level shared (LoadAll loads globally + admin sees them globally);
 *  - scope=project/version servers belong to a specific org, visible/manageable only by that org's (subtree) users,
 *    cross-org access always 404 (no distinction between "not found" and "invisible", preventing existence probing).
 *    Note: the CRUD control plane and LOADING (loadEnabledMcpServers) share one scope rule set —
 *    global in full, project/version follows thread ownership (see mcp.ts); no global load-everything.
 */
import { Router } from 'express';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assistantMcpServers, projectVersions } from '../../db/schema.js';
import { HttpError } from '../../middleware/errorHandler.js';
import type { AuthUser } from '../../services/auth.service.js';
import { assertProjectVisible, assertVersionVisible, visibleProjectIds } from '../../services/projectAccess.js';
import { MCP_EXPOSURES } from './mcp.js';
import { MCP_KINDS, normalizeMcpFields } from './mcpServersService.js';

export const mcpServersRoute = Router();

const SCOPE = ['global', 'project', 'version'] as const;

/** server-row visibility assertion: global shared; project/version org-owned, cross-org 404. */
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
  // Visibility filter: global returned in full; project/version returned only within visible projects (one visible-projects query + one version→project merge, avoiding per-row assertions)
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
    return true; // global: instance-level shared
  });
  res.json(filtered);
});

mcpServersRoute.post('/', async (req, res) => {
  const user = req.user as AuthUser;
  const b = req.body as Record<string, unknown>;
  // Scope-less fields (name/kind/exposure/command|url/args/env): full validation + normalization; same rule set as manage_mcp create.
  const f = normalizeMcpFields(b);
  // scope=project/version org ownership: cross-org 404 and must be asserted before insert (same semantics as guidesRoute)
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
  const rows = await db.insert(assistantMcpServers).values({
    ...f,
    scope,
    projectId: scope === 'project' ? (b.projectId as string) : null,
    versionId: scope === 'version' ? (b.versionId as string) : null,
    enabled: b.enabled === false ? false : true,
  }).returning();
  res.status(201).json(rows[0]);
});

mcpServersRoute.patch('/:id', async (req, res) => {
  const user = req.user as AuthUser;
  // PATCH loads the old row and asserts visibility first (cross-org 404), then validates/applies the diff (same semantics as guidesRoute)
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
    if (!MCP_KINDS.includes(kind as never)) throw new HttpError(400, 'bad_request', 'kind 必须是 stdio|http');
    patch.kind = kind;
    if (kind === 'stdio') {
      if (typeof p.command !== 'string' || !p.command.trim()) throw new HttpError(400, 'bad_request', 'kind=stdio 需要 command');
      patch.command = p.command.trim();
      patch.url = null; // switching to stdio — clear the http column so no stale column survives a kind change
    }
    if (kind === 'http') {
      if (typeof p.url !== 'string' || !/^https?:\/\//.test(p.url)) throw new HttpError(400, 'bad_request', 'kind=http 需要 http(s):// url');
      patch.url = p.url;
      patch.command = null; // switching to http — clear the command column
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
    if (!MCP_EXPOSURES.has(exp)) throw new HttpError(400, 'bad_request', `exposure 必须是 ${[...MCP_EXPOSURES].join('|')}（oauth 不支持）`);
    patch.exposure = exp;
  }
  // Switching scope to project/version must supply the corresponding id in the same PATCH, otherwise a stale id remains (same semantics as POST)
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
  // Post-change scope visibility: newly supplied or carried-over project/version ids must both point at visible projects
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
  // Loads the old row and asserts visibility first (cross-org 404), then deletes (same semantics as guidesRoute)
  const existing = (await db.select().from(assistantMcpServers).where(eq(assistantMcpServers.id, req.params.id)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'mcp server 不存在');
  await assertMcpServerVisible(existing, user);
  const deleted = await db.delete(assistantMcpServers)
    .where(eq(assistantMcpServers.id, req.params.id))
    .returning();
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'mcp server 不存在');
  res.status(204).end();
});