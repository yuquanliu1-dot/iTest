/**
 * 空间助手工具装配(原单文件 tools.ts 的目录化接缝)。
 * Plan 2:repo 沙箱(可用时)+ announce_plan + inspect_page + 四个领域工具。
 * 保持与 pi/tools.ts 相同的 ToolExecutor 形状(TypeBox schema + 可单测 execute)。
 */
import type { ToolExecutor } from '../../tools.js';
import { buildRepoSandboxTools } from '../../repo.js';
import type { SpaceToolsContext } from './context.js';
import { buildAnnounceTool } from './announce.js';
import { buildInspectTool } from './inspect.js';
import { buildCasesTools } from './cases.js';
import { buildScenariosTools } from './scenarios.js';

export type { SpaceToolsContext } from './context.js';
export { emitStage, type StageKind } from './stage.js';
export { diffText } from './diff.js';

export function buildSpaceTools(ctx: SpaceToolsContext): ToolExecutor[] {
  const tools: ToolExecutor[] = [];
  if (ctx.repoAvailable && ctx.cwd) tools.push(...buildRepoSandboxTools(ctx.cwd));
  tools.push(buildAnnounceTool(ctx), buildInspectTool(ctx));
  tools.push(...buildCasesTools(ctx));
  tools.push(...buildScenariosTools(ctx));
  return tools;
}
