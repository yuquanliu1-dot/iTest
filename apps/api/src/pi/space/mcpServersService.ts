/**
 * assistant_mcp_servers shared layer: global-level CRUD (validation + persistence + scope guards).
 * The server-side exposure allow-list lives in mcp.ts (MCP_EXPOSURES); it is imported from there,
 * so the route and the tool no longer each keep their own copy.
 *
 * Division of labor:
 *  - normalizeMcpFields      global (scope-independent field set) validation — shared by route POST and manage_mcp create.
 *  - createGlobalMcpServer   used by manage_mcp; route POST goes through its own scope branch (scope/projectId/versionId assertions stay in the route).
 *  - update/delete/list      used by manage_mcp; always "only scope=global may be changed" — project/version level is org-owned
 *                            and not managed from conversation (the settings page/route handles it, where visibility assertions exist).
 *  - Note: route PATCH keeps its own copy of the global-field validation due to visibility + scope cohesion logic; it must stay semantically identical
 *    to the rules here (kind ∈ stdio|http, exposure ∈ MCP_EXPOSURES, http url ^https?://, stdio requires command).
 */
import { and, asc, eq, ne } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assistantMcpServers } from '../../db/schema.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { MCP_EXPOSURES } from './mcp.js';

export const MCP_KINDS = ['stdio', 'http'] as const;

/** Scope-independent field validation + normalization (route POST and the tool's create share the same rule set). */
export function normalizeMcpFields(b: Record<string, unknown>): {
  name: string;
  kind: (typeof MCP_KINDS)[number];
  exposure: string;
  command: string | null;
  args: string[];
  url: string | null;
  env: Record<string, string> | null;
} {
  const rawKind = (b.kind as string) ?? 'stdio';
  if (!MCP_KINDS.includes(rawKind as never)) throw new HttpError(400, 'bad_request', 'kind 必须是 stdio|http');
  const kind = rawKind as (typeof MCP_KINDS)[number];
  const exposure = (b.exposure as string) ?? 'codemode';
  if (!MCP_EXPOSURES.has(exposure)) {
    throw new HttpError(400, 'bad_request', `exposure 必须是 ${[...MCP_EXPOSURES].join('|')}（oauth 不支持——服务端无 loopback 回调）`);
  }
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : null;
  if (!name) throw new HttpError(400, 'bad_request', 'name 必填');
  if (kind === 'stdio' && (typeof b.command !== 'string' || !b.command.trim())) {
    throw new HttpError(400, 'bad_request', 'kind=stdio 需要 command');
  }
  if (kind === 'http' && (typeof b.url !== 'string' || !/^https?:\/\//.test(b.url))) {
    throw new HttpError(400, 'bad_request', 'kind=http 需要 http(s):// url');
  }
  return {
    name,
    kind,
    exposure,
    command: kind === 'stdio' ? (b.command as string).trim() : null,
    args: kind === 'stdio' ? (Array.isArray(b.args) ? (b.args as string[]) : []) : [],
    url: kind === 'http' ? (b.url as string) : null,
    env: b.env && typeof b.env === 'object' ? (b.env as Record<string, string>) : null,
  };
}

/** Creates a global-level server (manage_mcp create; route POST's global branch is semantically identical). */
export async function createGlobalMcpServer(raw: Record<string, unknown>) {
  const f = normalizeMcpFields(raw);
  await assertMcpNameUnique(f.name);
  const rows = await db.insert(assistantMcpServers).values({
    ...f,
    scope: 'global',
    projectId: null,
    versionId: null,
    enabled: raw.enabled === false ? false : true,
  }).returning();
  return rows[0]!;
}

/** name globally unique (DB unique constraint); conflict → 409 (clean error instead of a PG duplicate-key 500). */
async function assertMcpNameUnique(name: string, excludeId?: string): Promise<void> {
  const conds = [eq(assistantMcpServers.name, name)];
  if (excludeId) conds.push(ne(assistantMcpServers.id, excludeId));
  const dup = (await db.select({ id: assistantMcpServers.id }).from(assistantMcpServers).where(and(...conds)).limit(1))[0];
  if (dup) throw new HttpError(409, 'conflict', 'mcp server 名称已存在');
}

/** Updates a global-level server (manage_mcp update): only scope=global may change; partial semantics match the route PATCH's global fields. */
export async function updateGlobalMcpServer(id: string, raw: Record<string, unknown>) {
  const existing = (await db.select().from(assistantMcpServers).where(eq(assistantMcpServers.id, id)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'mcp server 不存在');
  if (existing.scope !== 'global') throw new HttpError(403, 'forbidden', '仅 global 级 MCP 服务器可由助手对话管理（project/version 级请走系统设置页）');
  const patch: Partial<typeof assistantMcpServers.$inferInsert> = {};
  const p = raw;
  if ('name' in p) {
    if (typeof p.name !== 'string' || !p.name.trim()) throw new HttpError(400, 'bad_request', 'name 必填');
    const nm = p.name.trim();
    if (nm !== existing.name) await assertMcpNameUnique(nm, existing.id);
    patch.name = nm;
  }
  if ('kind' in p) {
    const kind = p.kind as string;
    if (!MCP_KINDS.includes(kind as never)) throw new HttpError(400, 'bad_request', 'kind 必须是 stdio|http');
    patch.kind = kind;
    if (kind === 'stdio') {
      if (typeof p.command !== 'string' || !p.command.trim()) throw new HttpError(400, 'bad_request', 'kind=stdio 需要 command');
      patch.command = p.command.trim();
      patch.url = null; // switching to stdio — clear the http column
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
  if ('enabled' in p) patch.enabled = p.enabled === false ? false : true;
  if (Object.keys(patch).length === 0) throw new HttpError(400, 'bad_request', 'update 至少给一项要改的字段');
  const updated = await db.update(assistantMcpServers)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(assistantMcpServers.id, id))
    .returning();
  if (updated.length === 0) throw new HttpError(404, 'not_found', 'mcp server 不存在');
  return updated[0]!;
}

/** Delete (manage_mcp delete): only scope=global may be deleted. */
export async function deleteMcpServerIfGlobal(id: string): Promise<void> {
  const existing = (await db.select().from(assistantMcpServers).where(eq(assistantMcpServers.id, id)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'mcp server 不存在');
  if (existing.scope !== 'global') throw new HttpError(403, 'forbidden', '仅 global 级 MCP 服务器可由助手对话管理（project/version 级请走系统设置页）');
  const deleted = await db.delete(assistantMcpServers).where(eq(assistantMcpServers.id, id)).returning();
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'mcp server 不存在');
}

/** Global-level listing (manage_mcp list; scope=project/version rows are not on this surface). */
export function listGlobalMcpServers() {
  return db.select().from(assistantMcpServers).where(eq(assistantMcpServers.scope, 'global')).orderBy(asc(assistantMcpServers.name));
}