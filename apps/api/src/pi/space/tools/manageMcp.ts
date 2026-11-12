/**
 * manage_mcp: conversationally manage global MCP servers (assistant_mcp_servers, scope=global) from the space assistant.
 * Shares the same exposure whitelist as the route (mcp.ts MCP_EXPOSURES) and the same field rules (mcpServersService.normalizeMcpFields).
 *
 * Registered only on "valid manager" threads (index.ts assembles by ctx.manager).
 * scope=global is the only manageable surface: project/version-level ownership belongs to the org; no visibility management in conversation.
 * name is globally unique in the DB (assistant_mcp_servers_name_uq), so like manage_skill it is addressed by name.
 * Action semantics:
 *   - list   : global server list (name/kind/exposure/enabled/command|url)
 *   - create : create (name/kind? stdio|http default stdio/exposure?/command+args?|url/env?/enabled?)
 *   - update : located by name; changes any of name(renameTo)/enabled/exposure/command/args/url/env/kind
 *   - delete : delete by name
 *
 * Effectiveness semantics: MCP is loaded at session start (session_start); changes take effect for [new sessions];
 * the current session's MCP tools stay on the build-time snapshot (new/renamed servers register only in a new session; deleted tools linger until reopening the session).
 */
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { assistantMcpServers } from '../../../db/schema.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';
import {
  createGlobalMcpServer,
  deleteMcpServerIfGlobal,
  listGlobalMcpServers,
  updateGlobalMcpServer,
} from '../mcpServersService.js';

const Actions = z.object({
  action: z.enum(['list', 'create', 'update', 'delete']),
  /** Name for create; update/delete use it for location (DB-unique). */
  name: z.string().min(1).max(120).optional(),
  kind: z.enum(['stdio', 'http']).optional(),
  exposure: z.string().max(12).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  env: z.record(z.string()).optional(),
  enabled: z.boolean().optional(),
  /** update: the new name after renaming (the original name remains the location key). */
  renameTo: z.string().min(1).max(120).optional(),
});

async function mcpServerIdByName(name: string): Promise<string> {
  const row = (await db.select({ id: assistantMcpServers.id }).from(assistantMcpServers).where(eq(assistantMcpServers.name, name)).limit(1))[0];
  return row?.id ?? '';
}

export function buildManageMcpTool(ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'manage_mcp',
    description:
      '对话式管理全局 MCP 服务器（仅 scope=global；project/version 级不受此工具管理）。服务器名全局唯一，按 name 寻址。action=list(global 清单:name/kind/exposure/enabled/command|url)| create(name, kind? stdio|http 缺省 stdio, exposure? 缺省 codemode, command+args?(stdio 必 command), url?(http 必 http(s)://), env? {KEY:val}, enabled?)| update(name + 任选 renameTo 改名/enabled/exposure/command/args/url/env/kind;kind 切换需带新 kind 必需字段)| delete(name)。服务端 exposure 白名单=codemode|deferred|direct|hidden(oauth 不支持)。改动对【新会话】生效(MCP 在 session_start 装载)——当前会话内新建/改名的服务器要新会话才注册为工具,删除后旧工具残留到重开会话。',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('list'),
        Type.Literal('create'),
        Type.Literal('update'),
        Type.Literal('delete'),
      ]),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
      kind: Type.Optional(Type.Union([Type.Literal('stdio'), Type.Literal('http')])),
      exposure: Type.Optional(Type.String()),
      command: Type.Optional(Type.String()),
      args: Type.Optional(Type.Array(Type.String())),
      url: Type.Optional(Type.String()),
      env: Type.Optional(Type.Record(Type.String(), Type.String())),
      enabled: Type.Optional(Type.Boolean()),
      renameTo: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    }),
    promptGuidelines: [
      '管理 MCP 属高权限操作（server 命令/地址在 API 容器执行），仅对管理员线程开放。',
      'update/delete 用 name 定位；改名用 renameTo（name 永远是定位键）。',
      'kind=stdio 要 command；kind=http 要 http(s):// url；exposure 只认 codemode|deferred|direct|hidden。',
      '改动对新会话生效：本会话内工具集不变，告知用户需新开会话加载。',
      'delete 不可逆，确认用户意图后再执行，并复述被删服务器名称。',
    ],
    execute: async (input) => {
      let v: z.infer<typeof Actions>;
      try {
        v = Actions.parse(input);
      } catch (e) {
        if (e instanceof z.ZodError) {
          return { ok: false, error: `参数不合法:${e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}` };
        }
        throw e;
      }
      if (!ctx.manager) return { ok: false, error: '无管理员权限，不能管理全局 MCP 服务器（需要管理员角色）' };
      try {
        switch (v.action) {
          case 'list': {
            const rows = await listGlobalMcpServers();
            return { ok: true, data: JSON.stringify(rows, null, 2) };
          }
          case 'create': {
            if (!v.name) return { ok: false, error: 'create 需要 name' };
            const created = await createGlobalMcpServer({
              name: v.name,
              kind: v.kind ?? 'stdio',
              ...(v.exposure !== undefined && { exposure: v.exposure }),
              ...(v.command !== undefined && { command: v.command }),
              ...(v.args !== undefined && { args: v.args }),
              ...(v.url !== undefined && { url: v.url }),
              ...(v.env !== undefined && { env: v.env }),
              ...(v.enabled !== undefined && { enabled: v.enabled }),
            });
            return { ok: true, data: JSON.stringify({ created: created.name, id: created.id, kind: created.kind }, null, 2) };
          }
          case 'update': {
            if (!v.name) return { ok: false, error: 'update 需要 name(目标服务器)' };
            const id = await mcpServerIdByName(v.name);
            if (!id) return { ok: false, error: `服务器不存在: ${v.name}` };
            const patch: Record<string, unknown> = {};
            if (v.renameTo !== undefined) patch.name = v.renameTo;
            if (v.kind !== undefined) patch.kind = v.kind;
            if (v.exposure !== undefined) patch.exposure = v.exposure;
            if (v.command !== undefined) patch.command = v.command;
            if (v.args !== undefined) patch.args = v.args;
            if (v.url !== undefined) patch.url = v.url;
            if (v.env !== undefined) patch.env = v.env;
            if (v.enabled !== undefined) patch.enabled = v.enabled;
            if (Object.keys(patch).length === 0) return { ok: false, error: 'update 至少给一项要改的字段' };
            const updated = await updateGlobalMcpServer(id, patch);
            return { ok: true, data: JSON.stringify({ updated: updated.name, id: updated.id }, null, 2) };
          }
          case 'delete': {
            if (!v.name) return { ok: false, error: 'delete 需要 name' };
            const id = await mcpServerIdByName(v.name);
            if (!id) return { ok: false, error: `服务器不存在: ${v.name}` };
            await deleteMcpServerIfGlobal(id);
            return { ok: true, data: JSON.stringify({ deleted: v.name }) };
          }
          default:
            return { ok: false, error: `unknown action ${(v as { action: string }).action}` };
        }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}