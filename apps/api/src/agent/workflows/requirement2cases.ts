import type { WorkflowSpec } from '../agentFactory.js';
import { createSaveCaseTool } from '../builtinTools.js';
import { REQUIREMENT_DECOMPOSE_PROMPT } from '../prompts/requirement-decompose.js';
import { CASE_REVIEW_PROMPT } from '../prompts/case-review.js';

/** 每个 run 用 targetId（requirement id）+ groupId（落库分组）构建。groupId 必须是有效的 UUID 字符串。 */
export function buildRequirement2CasesWorkflow(requirementId: string, groupId: string): WorkflowSpec {
  if (!groupId) throw new Error('groupId is required for requirement2cases');
  return {
    workflowId: 'requirement2cases',
    steps: [
      {
        id: 'decompose',
        prompt: REQUIREMENT_DECOMPOSE_PROMPT + '\n\nrequirement:\n{{userMessage}}',
        tools: [createSaveCaseTool({ requirementId, groupId })],
      },
      {
        id: 'review',
        prompt: CASE_REVIEW_PROMPT + '\n\ncandidates:\n{{previousOutput}}',
        tools: [],
      },
    ],
  };
}
