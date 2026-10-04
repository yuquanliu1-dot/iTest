/**
 * 空间助手工具装配(原单文件 tools.ts 的目录化接缝)。
 * Plan 2:repo 沙箱(后台异步检出,cwd 动态解析)+ announce_plan + inspect_page + 四个领域工具。
 * 保持与 pi/tools.ts 相同的 ToolExecutor 形状(TypeBox schema + 可单测 execute)。
 */
import type { ToolExecutor } from '../../tools.js';
import { buildRepoSandboxTools } from '../../repo.js';
import { repoToolCwd } from './context.js';
import type { SpaceToolsContext } from './context.js';
import { buildAnnounceTool } from './announce.js';
import { buildInspectTool } from './inspect.js';
import { buildCasesTools } from './cases.js';
import { buildScenariosTools } from './scenarios.js';
import { buildEnvironmentsTools } from './environments.js';
import { buildPlansTools } from './plans.js';

export type { SpaceToolsContext } from './context.js';
export { emitStage, type StageKind } from './stage.js';
export { diffText } from './diff.js';

export function buildSpaceTools(ctx: SpaceToolsContext): ToolExecutor[] {
  const tools: ToolExecutor[] = [];
  // repo 工具恒注册:cwd 经共享 RepoState 每次调用动态解析,后台检出完成前
  // 调用收到"尚未就绪"错误(而非工具缺席导致 AI 困惑)。
  tools.push(...buildRepoSandboxTools(() => repoToolCwd(ctx.repo)));
  tools.push(buildAnnounceTool(ctx), buildInspectTool(ctx));
  tools.push(...buildCasesTools(ctx));
  tools.push(...buildScenariosTools(ctx));
  tools.push(...buildEnvironmentsTools(ctx));
  tools.push(...buildPlansTools(ctx));
  return tools;
}
