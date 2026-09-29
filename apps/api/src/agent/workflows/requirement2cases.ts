import type { WorkflowSpec } from '../agentFactory.js';
import { createSaveCaseTool } from '../builtinTools.js';
import { REQUIREMENT_DECOMPOSE_PROMPT } from '../prompts/requirement-decompose.js';
import { CASE_REVIEW_PROMPT } from '../prompts/case-review.js';

export const requirement2CasesWorkflow: WorkflowSpec = {
  workflowId: 'requirement2cases',
  steps: [
    {
      id: 'decompose',
      prompt: REQUIREMENT_DECOMPOSE_PROMPT + '\n\nrequirement:\n{{userMessage}}',
      tools: [createSaveCaseTool({})],
    },
    {
      id: 'review',
      prompt: CASE_REVIEW_PROMPT + '\n\ncandidates:\n{{previousOutput}}',
      tools: [],
    },
  ],
};
