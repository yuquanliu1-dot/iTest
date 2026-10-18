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
import type { McpServerConfig } from '@earendil-works/pi-coding-agent';
import { logger } from '../../logger.js';

export interface AssistantMcpServer {
  name: string;
  config: McpServerConfig;
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

/** 线程创建时取 MCP servers。默认（无显式 loader）返回空集——Task 3 改为 DB 加载。 */
export async function getMcpServersForThread(ctx: McpThreadCtx): Promise<AssistantMcpServer[]> {
  if (!serversLoader) return [];
  try {
    return await serversLoader(ctx);
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