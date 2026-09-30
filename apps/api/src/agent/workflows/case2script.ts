import type { WorkflowSpec } from '../agentFactory.js';
import { createSaveStepsTool, createGetCaseTool } from '../builtinTools.js';
import { CASE_TO_SCRIPT_PROMPT } from '../prompts/case-to-script.js';
import { SCRIPT_SELFCHECK_PROMPT } from '../prompts/script-selfcheck.js';

/** 每个 run 用 targetId（case id）构建：saveSteps/getCase 工具需要定位目标用例。 */
export function buildCase2ScriptWorkflow(caseId: string): WorkflowSpec {
  return {
    workflowId: 'case2script',
    steps: [
      {
        id: 'generate',
        prompt: CASE_TO_SCRIPT_PROMPT + '\n\ncase:\n{{userMessage}}',
        tools: [createSaveStepsTool({ caseId }), createGetCaseTool({ caseId })],
      },
      {
        id: 'selfcheck',
        prompt: SCRIPT_SELFCHECK_PROMPT + '\n\ngenerated:\n{{previousOutput}}',
        tools: [],
      },
    ],
  };
}
