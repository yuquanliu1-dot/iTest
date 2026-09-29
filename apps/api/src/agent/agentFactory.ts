import type { LLMClient } from './llm-client.js';
import type { AgentTool } from './builtinTools.js';

export interface WorkflowStep {
  id: string;
  prompt: string;
  tools: AgentTool[];
}

export interface WorkflowSpec {
  workflowId: string;
  steps: WorkflowStep[];
}

export interface RunOptions {
  workflowId: string;
  steps: WorkflowStep[];
  llmClient: LLMClient;
  initialMessage: string;
  onEvent: (e: AgentEvent) => void;
}

export type AgentEvent =
  | { type: 'step_start'; stepId: string }
  | { type: 'step_text'; stepId: string; delta: string }
  | { type: 'step_complete'; stepId: string; output: unknown }
  | { type: 'workflow_complete'; runId: string; result: unknown }
  | { type: 'workflow_error'; runId: string; error: string; code: 'llm' | 'schema' | 'db' | 'unknown' };

function fillTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

export async function runWorkflow(opts: RunOptions): Promise<unknown> {
  const runId = crypto.randomUUID();
  let previousOutput = '';
  const result: unknown[] = [];
  for (const step of opts.steps) {
    opts.onEvent({ type: 'step_start', stepId: step.id });
    const userMessage = fillTemplate(step.prompt, { userMessage: opts.initialMessage, previousOutput });
    try {
      const r = await opts.llmClient.complete({ systemPrompt: '', userMessage });
      const output = r.value;
      result.push(output);
      previousOutput = typeof output === 'string' ? output : JSON.stringify(output);
      opts.onEvent({ type: 'step_text', stepId: step.id, delta: previousOutput });
      opts.onEvent({ type: 'step_complete', stepId: step.id, output });
    } catch (e) {
      opts.onEvent({
        type: 'workflow_error',
        runId,
        error: e instanceof Error ? e.message : String(e),
        code: 'llm',
      });
      throw e;
    }
  }
  opts.onEvent({ type: 'workflow_complete', runId, result });
  return result;
}
