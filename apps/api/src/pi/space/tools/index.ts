/**
 * Space assistant tool assembly (the directory-form seam of the former single-file tools.ts).
 * Plan 2: repo sandbox (background async checkout, dynamic cwd resolution) + announce_plan + inspect_page + four domain tools.
 * Keeps the same ToolExecutor shape as pi/tools.ts (TypeBox schema + unit-testable execute).
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
import { buildDatasetsTools } from './datasets.js';
import { buildDevicesTools } from './devices.js';
import { buildPlansTools } from './plans.js';
import { buildHistoryTools } from './history.js';
import { buildStageTools } from './stage-tools.js';
import { buildLoginTools } from './login.js';
import { buildVerifyCaseTool } from './verifyCase.js';
import { buildDumpCasesPayloadTool } from './dumpCasesPayload.js';
import { buildSolidifyCaseTool } from './solidifyCase.js';
import { buildCaseOpsTools } from './case-ops-tools.js';
import { buildReadSkillTool } from './readSkill.js';
import { buildRunSkillScriptTool } from './runSkillScript.js';
import { buildReadThreadAttachmentTool } from './readThreadAttachment.js';
import { buildManageSkillTool } from './manageSkill.js';
import { buildManageMcpTool } from './manageMcp.js';
import { buildImportSkillTool } from './importSkill.js';
import { buildSaveRcaResultTool } from './saveRcaResult.js';
import { buildMemoryTools } from './memories.js';
import { buildTrajectoryTools } from './trajectories.js';

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
  // repo tools are always registered: cwd is resolved dynamically per call via the shared RepoState, and before the
  // background checkout completes calls receive a "not ready yet" error (rather than tool absence confusing the AI).
  tools.push(...buildRepoSandboxTools(() => repoToolCwd(ctx.repo)));
  tools.push(buildAnnounceTool(ctx), buildInspectTool(ctx));
  // Three coexisting families: stage_* / stage_case_op / manage_*:
  //   - stage_case     → stages a "brand-new case"; the user checks it in StagePanel → picks the target group → persisted
  //   - stage_case_op  → stages "modifications of an existing case/steps", ditto
  //   - manage_cases   → only handles search/get/create_group (real-time reads + only group creation keeps real-time writes)
  tools.push(...buildLoginTools(ctx));
  tools.push(buildReadSkillTool());
  // R1 short-term memory: available on chat/rca threads alike (shared within the product line; write gating is in the tool description)
  tools.push(...buildMemoryTools(ctx));
  // R2 success-trajectory retrieval: fetch same-line exemplars as few-shot before authoring a case (read path; copying in-line facts is forbidden)
  tools.push(...buildTrajectoryTools(ctx));
  tools.push(buildRunSkillScriptTool(ctx));
  tools.push(buildReadThreadAttachmentTool(ctx));
  // Management tools (manage_skill / manage_mcp / import_skill) are registered only on "valid manager" threads: they change globally shared config
  // (skill scripts / MCP commands execute on the API container); non-manager sessions have no such surface, guarding against hallucinated model calls.
  if (ctx.manager) {
    tools.push(buildManageSkillTool(ctx));
    tools.push(buildManageMcpTool(ctx));
    tools.push(buildImportSkillTool(ctx));
  }
  tools.push(buildDumpCasesPayloadTool(ctx));
  tools.push(buildVerifyCaseTool(ctx));
  tools.push(buildSolidifyCaseTool(ctx));
  tools.push(...buildStageTools(ctx));
  tools.push(...buildCaseOpsTools(ctx));
  tools.push(...buildCasesTools(ctx));
  tools.push(...buildScenariosTools(ctx));
  tools.push(...buildEnvironmentsTools(ctx));
  tools.push(...buildDatasetsTools(ctx));
  tools.push(...buildDevicesTools(ctx));
  tools.push(...buildPlansTools(ctx));
  tools.push(...buildHistoryTools(ctx));
  // RCA-only persistence tool: visible only on root-cause-analysis background threads; ordinary chat threads never see this tool surface.
  if (ctx.purpose === 'rca') {
    tools.push(buildSaveRcaResultTool(ctx));
  }
  return tools;
}
