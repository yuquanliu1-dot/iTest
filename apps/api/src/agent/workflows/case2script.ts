import type { WorkflowSpec } from '../agentFactory.js';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { testCases } from '../../db/schema.js';
import { resolveCaseUrl } from '../../lib/resolve-url.js';
import { inspectPage } from '../../pi/inspectPage.js';
import { createSaveStepsTool, createGetCaseTool } from '../builtinTools.js';
import { CASE_TO_SCRIPT_PROMPT } from '../prompts/case-to-script.js';
import { SCRIPT_SELFCHECK_PROMPT } from '../prompts/script-selfcheck.js';

/**
 * 预取被测页面真实元素快照，作为定位器的唯一可信来源注入 prompt。
 * 生成前抓不到真实元素是 LLM 臆造 testid/css 的直接原因；抓取失败不阻断 run。
 */
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
      '目标页面快照（真实元素清单，生成定位器前必读）:',
      snap,
      '快照使用规则:',
      '- locator 的 testId / id / aria-label / css 值只能取自上面清单；清单里没有的元素用 role 或 text 定位，禁止编造。',
      '- navigate 的 url 必须使用快照中的真实 URL。',
      '- 结果区/错误提示等操作后才出现的元素不在快照中：先触发操作再断言，或断言清单中稳定的父容器。',
    ].join('\n');
  } catch (e) {
    return [
      '',
      '',
      `目标页面快照: 抓取失败（${url}：${e instanceof Error ? e.message : String(e)}）。仅凭用例描述生成，定位器优先 role/text，禁止编造 testid/id。`,
    ].join('\n');
  }
}

/** 每个 run 用 targetId（case id）构建：saveSteps/getCase 工具需要定位目标用例。 */
export async function buildCase2ScriptWorkflow(caseId: string): Promise<WorkflowSpec> {
  const snapshot = await fetchPageSnapshot(caseId);
  return {
    workflowId: 'case2script',
    steps: [
      {
        id: 'generate',
        prompt: CASE_TO_SCRIPT_PROMPT + snapshot + '\n\ncase:\n{{userMessage}}',
        tools: [createSaveStepsTool({ caseId }), createGetCaseTool({ caseId })],
      },
      {
        id: 'selfcheck',
        prompt: SCRIPT_SELFCHECK_PROMPT + snapshot + '\n\ngenerated:\n{{previousOutput}}',
        tools: [],
      },
    ],
  };
}
