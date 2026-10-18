/**
 * 空间助手 MCP 支持：DB 配置 + pi.registerMcpServer 通用通道（spec 2026-10-18）。
 *
 * pi 集成 = createMcpExtension（ExtensionFactory，session_start 建连）+ ExtensionAPI.registerMcpServer。
 * 本模块提供：
 *  - loader seam：setMcpServersLoader / getMcpServersForThread。Task 1 默认空集；
 *    Task 3 把默认翻成 DB 查询 loadEnabledMcpServers。测试用 setMcpServersLoader 注入桩。
 *  - buildMcpExtensionFactory：把 server 列表装配成「注册 + 建连装载」两个 extension factory。
 *
 * 顺序约束（见计划头部关键事实 §1）：session.ts 里 skills → mcp → identity。
 * bindExtensions 必需：pi 的 session_start 只在 bindExtensions 里 emit，MCP 建连在 session_start 做。
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

/** 合法的 MCP exposure 集合（不含 oauth——服务端无 loopback 回调能力）。CRUD 路由与装载共用，
 *  避免两个 allow-list 各自漂移（对齐 spec §MCP）。 */
export const MCP_EXPOSURES = new Set(['codemode', 'deferred', 'direct', 'hidden']);

/** env 值解引用：`env:KEY` 语法从 process.env 取（容器 secrets 统一走宿主机注入，明文不落 DB）。
 *  未定义 key 直接丢弃（不注入空占位）。 */
export function resolveMcpEnv(env?: Record<string, string> | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (typeof v !== 'string') continue; // DB 脏值防御：非字符串直接丢弃
    if (v.startsWith('env:')) {
      const real = process.env[v.slice(4)];
      if (real !== undefined) out[k] = real;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** stdio command 可执行性探测：含路径分隔符 → 按绝对/相对路径 X_OK；否则按 PATH 逐个 scan X_OK。 */
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

/** 行 → 可挂载 server；每条坏配置 skip+warn（warn-not-fail：一个坏 server 不拖垮整个助手）。
 *  守卫（spec §MCP）：exposure=oauth/非法 → 拒；kind 未知 → 拒；stdio 缺 command/二进制不可执行 → 拒；
 *  http url 非 http(s) → 拒。返回 null 表示跳过。 */
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
    // 上方 MCP_EXPOSURES 已守卫，drizzle varchar 的 exposure 是 string，这里收窄成 McpExposure
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

/** 从 assistant_mcp_servers 表加载启用 server（坏配置跳过）。scope 过滤跟随线程归属：
 *  global 全量；project/version 只加载与线程 projectId/versionId 匹配的行（跨组织不泄漏）。
 *  ctx 缺省时只加载 global（测试/无归属场景安全默认，绝不全量抓 scoped 行）。 */
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

/** 注入 MCP server loader（测试桩 / Task 3 默认翻 DB）。传 null 恢复默认。 */
export function setMcpServersLoader(fn: McpServersLoader | null): void {
  serversLoader = fn;
}

/** 线程创建时取 MCP servers。默认 = DB 加载（带 scope 过滤）；测试用 setMcpServersLoader 注入桩。 */
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

/** 装配 MCP 扩展：先 registerMcpServer 前置注册，再 createMcpExtension hermetic 建连。
 *  两个 factory 都进 session.ts 的 extensionFactories，且必须排在 identity 前。 */
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
      // hermetic：不读 mcp.json，pi.registerMcpServer 是唯一来源
      factory: createMcpExtension({
        loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: true }),
      }),
    },
  };
}