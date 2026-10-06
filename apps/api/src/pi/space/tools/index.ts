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
import { buildStageTools } from './stage-tools.js';
import { buildCaseOpsTools } from './case-ops-tools.js';

export type { SpaceToolsContext } from './context.js';
export { emitStage, type StageKind } from './stage.js';
export { diffText } from './diff.js';
export {
  buildStageTools,
  STAGE_PROMPT_GUIDELINES,
  listStage,
  stageCase,
  stageScenario,
  stageEnvironment,
  stagePlan,
  deleteStaged,
  type StagedCase,
  type StagedScenario,
  type StagedEnvironment,
  type StagedPlan,
  type StageDoc,
  type StageKind as StageObjectKind,
} from './stage-tools.js';
export {
  buildCaseOpsTools,
  STAGE_CASE_OP_GUIDELINES,
  stageCaseOp,
  applyCaseOp,
  type StageCaseOpInput,
} from './case-ops-tools.js';

export function buildSpaceTools(ctx: SpaceToolsContext): ToolExecutor[] {
  const tools: ToolExecutor[] = [];
  // repo 工具恒注册:cwd 经共享 RepoState 每次调用动态解析,后台检出完成前
  // 调用收到"尚未就绪"错误(而非工具缺席导致 AI 困惑)。
  tools.push(...buildRepoSandboxTools(() => repoToolCwd(ctx.repo)));
  tools.push(buildAnnounceTool(ctx), buildInspectTool(ctx));
  // stage_* / stage_case_op / manage_* 三个家族并存：
  //   - stage_case     → 暂存「全新用例」，用户在 StagePanel 勾选 → 选目标分组 → 落库
  //   - stage_case_op  → 暂存「对已有用例/步骤的修改」，同上
  //   - manage_cases   → 仅负责 search/get/create_group（实时读 + 仅分组创建仍保留实时写）
  tools.push(...buildStageTools(ctx));
  tools.push(...buildCaseOpsTools(ctx));
  tools.push(...buildCasesTools(ctx));
  tools.push(...buildScenariosTools(ctx));
  tools.push(...buildEnvironmentsTools(ctx));
  tools.push(...buildPlansTools(ctx));
  return tools;
}
