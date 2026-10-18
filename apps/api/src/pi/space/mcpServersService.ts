/**
 * assistant_mcp_servers 共用层：global 级 CRUD（校验 + 落库 + scope 守卫）。
 * 服务端 exposure 白名单在 mcp.ts（MCP_EXPOSURES），此处从那里取，route 与工具不再各写一份。
 *
 * 分工：
 *  - normalizeMcpFields      全局（与 scope 无关的字段集）校验——route POST 与 manage_mcp create 共用。
 *  - createGlobalMcpServer   manage_mcp 用；route POST 走自身 scope 分支（scope/projectId/versionId 断言留在 route）。
 *  - update/delete/list      manage_mcp 用；一律「scope=global 才可改动」——project/version 级归属组织，
 *                            对话内不管理（设置页/route 负责，那里有可见性断言）。
 *  - 注意：route PATCH 因可见性 + scope 内聚逻辑保留自己的全局字段校验副本；与这里的规则必须同语义
 *    （kind ∈ stdio|http、exposure ∈ MCP_EXPOSURES、http url ^https?://、stdio 必 command）。
 */
import { and, asc, eq, ne } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assistantMcpServers } from '../../db/schema.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { MCP_EXPOSURES } from './mcp.js';

export const MCP_KINDS = ['stdio', 'http'] as const;

/** 与 scope 无关的字段校验 + 归一化（route POST 与工具 create 共用同一套规则）。 */
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

/** 建 global 级 server（manage_mcp create；route POST 的 global 分支语义一致）。 */
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

/** name 全局唯一（DB 唯一约束）；冲突 → 409（干净报错而非 PG duplicate key 500）。 */
async function assertMcpNameUnique(name: string, excludeId?: string): Promise<void> {
  const conds = [eq(assistantMcpServers.name, name)];
  if (excludeId) conds.push(ne(assistantMcpServers.id, excludeId));
  const dup = (await db.select({ id: assistantMcpServers.id }).from(assistantMcpServers).where(and(...conds)).limit(1))[0];
  if (dup) throw new HttpError(409, 'conflict', 'mcp server 名称已存在');
}

/** 更新 global 级 server（manage_mcp update）：scope=global 才可改；partial 语义与 route PATCH 全局字段一致。 */
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
      patch.url = null; // 切到 stdio，清掉 http 列
    }
    if (kind === 'http') {
      if (typeof p.url !== 'string' || !/^https?:\/\//.test(p.url)) throw new HttpError(400, 'bad_request', 'kind=http 需要 http(s):// url');
      patch.url = p.url;
      patch.command = null; // 切到 http，清掉 command 列
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

/** 删除（manage_mcp delete）：scope=global 才可删。 */
export async function deleteMcpServerIfGlobal(id: string): Promise<void> {
  const existing = (await db.select().from(assistantMcpServers).where(eq(assistantMcpServers.id, id)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'mcp server 不存在');
  if (existing.scope !== 'global') throw new HttpError(403, 'forbidden', '仅 global 级 MCP 服务器可由助手对话管理（project/version 级请走系统设置页）');
  const deleted = await db.delete(assistantMcpServers).where(eq(assistantMcpServers.id, id)).returning();
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'mcp server 不存在');
}

/** global 级清单（manage_mcp list；scope=project/version 行不在此面上）。 */
export function listGlobalMcpServers() {
  return db.select().from(assistantMcpServers).where(eq(assistantMcpServers.scope, 'global')).orderBy(asc(assistantMcpServers.name));
}