/**
 * 空间助手工具接缝。Plan 1 仅注入 repo 沙箱工具;Plan 2 在这里追加
 * manage_cases / manage_scenarios / manage_environments / manage_plans / announce_plan。
 * 保持与 pi/tools.ts 相同的 ToolExecutor 形状(TypeBox schema + 可单测 execute)。
 */
import type { ToolExecutor } from '../tools.js';
import { buildRepoSandboxTools } from '../repo.js';

export interface SpaceToolsContext {
  threadId: string;
  versionId: string;
  projectId: string;
  cwd: string | null;
  repoAvailable: boolean;
  /** 向当前线程 SSE 订阅者广播自定义事件(confirm_request / 舞台对象等)。 */
  emit: (e: Record<string, unknown>) => void;
}

export function buildSpaceTools(ctx: SpaceToolsContext): ToolExecutor[] {
  const tools: ToolExecutor[] = [];
  if (ctx.repoAvailable && ctx.cwd) tools.push(...buildRepoSandboxTools(ctx.cwd));
  return tools;
}
