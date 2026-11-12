/**
 * Space-assistant MCP support: DB config + pi.registerMcpServer generic channel (spec 2026-10-18).
 *
 * pi integration = createMcpExtension (ExtensionFactory, connects on session_start) + ExtensionAPI.registerMcpServer.
 * This module provides:
 *  - loader seam: setMcpServersLoader / getMcpServersForThread. Task 1 defaults to an empty set;
 *    Task 3 flips the default to the DB query loadEnabledMcpServers. Tests inject stubs via setMcpServersLoader.
 *  - buildMcpExtensionFactory: assembles the server list into the two extension factories, "register + connect".
 *
 * Order constraint (see the plan header's key facts §1): in session.ts, skills → mcp → identity.
 * bindExtensions is required: pi emits session_start only inside bindExtensions, and MCP connects on session_start.
 */
import { createMcpExtension } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { McpExposure, McpServerConfig } from '@earendil-works/pi-coding-agent';
import { eq } from 'drizzle-orm';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { db } from '../../db/client.js';
import { assistantMcpServers } from '../../db/schema.js';
import { logger } from '../../logger.js';

export interface AssistantMcpServer {
  name: string;
  config: McpServerConfig;
}

type AssistantMcpServerRow = typeof assistantMcpServers.$inferSelect;

/** Legal MCP exposure set (no oauth — the server has no loopback-callback capability). Shared by the CRUD route and loading,
 *  so the two allow-lists cannot drift apart (aligned with spec §MCP). */
export const MCP_EXPOSURES = new Set(['codemode', 'deferred', 'direct', 'hidden']);

/** env-value dereference: the `env:KEY` syntax pulls from process.env (container secrets all arrive via host injection, plaintext never lands in the DB).
 *  Undefined keys are dropped outright (no empty placeholder injected). */
export function resolveMcpEnv(env?: Record<string, string> | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (typeof v !== 'string') continue; // dirty-DB-value defense: non-strings dropped outright
    if (v.startsWith('env:')) {
      const real = process.env[v.slice(4)];
      if (real !== undefined) out[k] = real;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** stdio command executability probe: contains a path separator → X_OK as an absolute/relative path; otherwise scan each PATH dir for X_OK. */
export function findExecutable(cmd: string): boolean {
  if (cmd.includes('/')) {
    try { accessSync(cmd, constants.X_OK); return true; } catch { return false; }
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    try { accessSync(path.join(dir, cmd), constants.X_OK); return true; } catch { /* continue */ }
  }
  return false;
}

/** Row → mountable server; each bad config is skip+warn (warn-not-fail: one bad server must not drag down the whole assistant).
 *  Guards (spec §MCP): exposure=oauth/illegal → reject; unknown kind → reject; stdio missing command/binary not executable → reject;
 *  http url not http(s) → reject. Returning null means skip. */
export function mcpServerToEntry(row: AssistantMcpServerRow): AssistantMcpServer | null {
  if (!MCP_EXPOSURES.has(row.exposure)) {
    logger.warn({ name: row.name, exposure: row.exposure }, 'mcp server exposure 非法（oauth 等均不支持），跳过');
    return null;
  }
  if (row.kind === 'stdio') {
    if (!row.command) { logger.warn({ name: row.name }, 'mcp stdio server 缺少 command，跳过'); return null; }
    if (!findExecutable(row.command)) {
      logger.warn({ name: row.name, command: row.command }, 'mcp stdio server 二进制不可执行，跳过（warn-not-fail）');
      return null;
    }
    // MCP_EXPOSURES above already guards this; drizzle varchar's exposure is string — narrow it to McpExposure here
    return { name: row.name, config: { type: 'stdio', command: row.command, args: row.args ?? [], env: resolveMcpEnv(row.env), exposure: row.exposure as McpExposure } };
  }
  if (row.kind === 'http') {
    if (!row.url || !/^https?:\/\//.test(row.url)) {
      logger.warn({ name: row.name, url: row.url }, 'mcp http server url 非 http(s)，跳过（防 file:// 等本地读取）');
      return null;
    }
    return { name: row.name, config: { type: 'http', url: row.url, headers: resolveMcpEnv(row.env), exposure: row.exposure as McpExposure } };
  }
  logger.warn({ name: row.name, kind: row.kind }, 'mcp server kind 未知，跳过');
  return null;
}

/** Loads enabled servers from the assistant_mcp_servers table (bad configs skipped). Scope filtering follows thread ownership:
 *  global in full; project/version only rows matching the thread's projectId/versionId (no cross-org leak).
 *  ctx absent → load global only (safe default for tests/unowned scenarios; never grab all scoped rows). */
export async function loadEnabledMcpServers(ctx?: { projectId?: string | null; versionId?: string | null }): Promise<AssistantMcpServer[]> {
  const rows = await db.select().from(assistantMcpServers).where(eq(assistantMcpServers.enabled, true));
  const out: AssistantMcpServer[] = [];
  for (const row of rows) {
    if (row.scope === 'project' && row.projectId !== ctx?.projectId) continue;
    if (row.scope === 'version' && row.versionId !== ctx?.versionId) continue;
    const entry = mcpServerToEntry(row);
    if (entry) out.push(entry);
  }
  return out;
}

export interface McpThreadCtx {
  threadId: string;
  projectId: string;
  versionId: string;
}

type McpServersLoader = (ctx: McpThreadCtx) => Promise<AssistantMcpServer[]>;

let serversLoader: McpServersLoader | null = null;

/** Injects the MCP server loader (test stub / Task 3 flips the default to DB). Pass null to restore the default. */
export function setMcpServersLoader(fn: McpServersLoader | null): void {
  serversLoader = fn;
}

/** Fetches MCP servers at thread creation. Default = DB load (with scope filtering); tests inject stubs via setMcpServersLoader. */
export async function getMcpServersForThread(ctx: McpThreadCtx): Promise<AssistantMcpServer[]> {
  const loader: McpServersLoader =
    serversLoader ?? (async (c) => loadEnabledMcpServers({ projectId: c.projectId, versionId: c.versionId }));
  try {
    return await loader(ctx);
  } catch (e) {
    logger.warn({ err: e, threadId: ctx.threadId }, 'mcp servers load failed; continuing without');
    return [];
  }
}

/** Assembles MCP extensions: registerMcpServer pre-registration first, then createMcpExtension hermetic connect.
 *  Both factories go into session.ts's extensionFactories and must be ordered before identity. */
export function buildMcpExtensionFactory(servers: AssistantMcpServer[]): {
  register: { name: string; hidden: boolean; factory: (pi: ExtensionAPI) => void };
  connect: { name: string; hidden: boolean; factory: ReturnType<typeof createMcpExtension> };
} {
  return {
    register: {
      name: 'itest-space-mcp-register',
      hidden: true,
      factory: (pi: ExtensionAPI) => {
        for (const s of servers) pi.registerMcpServer(s.name, s.config);
      },
    },
    connect: {
      name: 'itest-space-mcp',
      hidden: true,
      // hermetic: does not read mcp.json — pi.registerMcpServer is the sole source
      factory: createMcpExtension({
        loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: true }),
      }),
    },
  };
}