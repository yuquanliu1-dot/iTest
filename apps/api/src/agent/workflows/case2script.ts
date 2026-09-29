import type { WorkflowSpec } from '../agentFactory.js';
import { createSaveStepsTool, createGetCaseTool } from '../builtinTools.js';
import { CASE_TO_SCRIPT_PROMPT } from '../prompts/case-to-script.js';
import { SCRIPT_SELFCHECK_PROMPT } from '../prompts/script-selfcheck.js';

export const case2ScriptWorkflow: WorkflowSpec = {
  workflowId: 'case2script',
  steps: [
    {
      id: 'generate',
      prompt: CASE_TO_SCRIPT_PROMPT + '\n\ncase:\n{{userMessage}}',
      tools: [createSaveStepsTool(), createGetCaseTool()],
    },
    {
      id: 'selfcheck',
      prompt: SCRIPT_SELFCHECK_PROMPT + '\n\ngenerated:\n{{previousOutput}}',
      tools: [],
    },
  ],
};
