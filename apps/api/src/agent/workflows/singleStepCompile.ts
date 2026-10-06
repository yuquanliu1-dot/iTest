/**
 * 单步骤 AI 重编译工作流：
 * - 复用 fetchPageSnapshot 抓真实页面元素（与 case2script 同一来源）
 * - 复用 runWorkflow / Agent 循环（多轮调 LLM，与 case2script 一致）
 * - 区别：userMessage 聚焦在「为这一条 step 编出 compiled DSL」；输出格式是
 *   { compiled: StepAction[] }，通过一个 saveSingleStep tool 把 compiled 落到
 *   test_steps.compiled 列上。
 * - 不在 stage-tools 里加 recompile_step 是为了避免空间助手对话流被破坏：
 *   单步骤编辑是 UI 行级按钮触发的,期望同步阻塞返回,不需要走 SSE 对话。
 */
import type { WorkflowSpec } from '../agentFactory.js';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { testCases } from '../../db/schema.js';
import { resolveCaseUrl } from '../../lib/resolve-url.js';
import { inspectPage } from '../../pi/inspectPage.js';
import { createSaveSingleStepTool, createGetStepTool } from '../builtinSingleStepTools.js';
import { SINGLE_STEP_COMPILE_PROMPT } from '../prompts/single-step-compile.js';

async function fetchPageSnapshot(caseId: string): Promise<string> {
  const rows = await db.select().from(testCases).where(eq(testCases.id, caseId)).limit(1);
  const c = rows[0];
  if (!c) return '';
  const url = await resolveCaseUrl(c, { defaultEnvFallback: true });
  if (!url) return '';
  try {
    const snap = await inspectPage(url);
    return [
      '',
      '',
      '目标页面快照（真实元素清单,生成定位器前必读）:',
      snap,
      '快照使用规则:',
      '- locator 的 testId / id / aria-label / css 值只能取自上面清单；清单里没有的元素用 role 或 text 定位,禁止编造。',
      '- navigate 的 url 必须使用快照中的真实 URL。',
      '- 结果区/错误提示等操作后才出现的元素不在快照中：先触发操作再断言,或断言清单中稳定的父容器。',
    ].join('\n');
  } catch (e) {
    return [
      '',
      '',
      `目标页面快照: 抓取失败（${url}：${e instanceof Error ? e.message : String(e)}）。仅凭用例描述生成,定位器优先 role/text,禁止编造 testid/id。`,
    ].join('\n');
  }
}

/** 单 step 重编译 workflow:由 POST /steps/ai-edit 同步调用,不走 SSE。
 *  - generate step 输出 { compiled: StepAction[] } 后由 saveSingleStep tool 落库;
 *    落库结果经 runWorkflow.onEvent 回调透传。
 *  - 不走 selfcheck(单步重编 prompt 已足够严格;自检会引入 1 轮 LLM 延迟)。 */
export async function buildSingleStepCompileWorkflow(opts: { caseId: string; stepId: string }): Promise<WorkflowSpec> {
  const snapshot = await fetchPageSnapshot(opts.caseId);
  return {
    workflowId: 'singleStepCompile',
    steps: [
      {
        id: 'generate',
        prompt: SINGLE_STEP_COMPILE_PROMPT + snapshot + '\n\ncase/step:\n{{userMessage}}',
        tools: [
          createGetStepTool({ stepId: opts.stepId }),
          createSaveSingleStepTool({ stepId: opts.stepId }),
        ],
      },
    ],
  };
}