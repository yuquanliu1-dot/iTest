import { describe, it, expect } from 'vitest';
import { runWorkflow } from '../src/agent/agentFactory.js';
import type { LLMClient, LLMRequest, LLMResult } from '../src/agent/llm-client.js';

/** 替代已删除的 MockClient：requirement 输入返回 cases JSON，其余返回 text。 */
function fakeClient(): LLMClient {
  return {
    provider: 'openai',
    async complete(req: LLMRequest): Promise<LLMResult> {
      if (req.userMessage.includes('requirement') || req.userMessage.includes('需求')) {
        return {
          kind: 'json',
          value: {
            cases: [
              {
                title: 'fake 生成的用例',
                description: 'fake client 产出',
                priority: 'P1',
                steps: [{ order: 1, action: { kind: 'navigate', url: 'https://example.com' } }],
              },
            ],
          },
          provider: 'openai',
          vision: false,
        };
      }
      return { kind: 'text', value: '[fake] no specific response for this input', provider: 'openai', vision: false };
    },
  };
}

describe('workflow', () => {
  it('runs a two-step workflow sequentially', async () => {
    const client = fakeClient();
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

  it('invokes step tools with the step output after step_complete', async () => {
    const client = fakeClient();
    const calls: unknown[] = [];
    await runWorkflow({
      workflowId: 'tools',
      steps: [
        {
          id: 'a',
          prompt: 'requirement 相关，走 fake 的 cases 分支',
          tools: [{ name: 'probe', description: '', handler: async (input) => { calls.push(input); return { ok: true }; } }],
        },
      ],
      llmClient: client,
      initialMessage: 'whatever',
      onEvent: () => {},
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveProperty('cases');
  });

  it('tool handler errors abort the run with a db code', async () => {
    const client = fakeClient();
    const events: Array<{ type: string; code?: string }> = [];
    await expect(
      runWorkflow({
        workflowId: 'tool-fail',
        steps: [
          {
            id: 'a',
            prompt: 'requirement 相关',
            tools: [{ name: 'bad', description: '', handler: async () => { throw new Error('insert failed'); } }],
          },
        ],
        llmClient: client,
        initialMessage: 'x',
        onEvent: (e) => events.push(e as { type: string; code?: string }),
      }),
    ).rejects.toThrow('insert failed');
    const err = events.find((e) => e.type === 'workflow_error');
    expect(err?.code).toBe('db');
  });
});
