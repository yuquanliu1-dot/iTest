import { describe, it, expect } from 'vitest';
import { runWorkflow } from '../src/agent/agentFactory.js';
import { getLlmClient } from '../src/agent/llm-client.js';

describe('workflow', () => {
  it('runs a two-step workflow sequentially', async () => {
    const client = getLlmClient({ provider: 'mock', apiKey: '', model: '' });
    const events: string[] = [];
    const result = await runWorkflow({
      workflowId: 'test',
      steps: [
        { id: 'a', prompt: 'step A uses {{userMessage}}', tools: [] },
        { id: 'b', prompt: 'step B uses {{previousOutput}}', tools: [] },
      ],
      llmClient: client,
      initialMessage: 'hello',
      onEvent: (e) => events.push(e.type),
    });
    expect(result).toBeTruthy();
    expect(events).toContain('step_start');
    expect(events).toContain('workflow_complete');
  });

  it('stops on first error', async () => {
    const client = {
      provider: 'mock' as const,
      complete: async () => {
        throw new Error('boom');
      },
    };
    await expect(
      runWorkflow({
        workflowId: 'fail',
        steps: [{ id: 'a', prompt: 'x', tools: [] }],
        llmClient: client,
        initialMessage: 'y',
        onEvent: () => {},
      }),
    ).rejects.toThrow('boom');
  });
});
