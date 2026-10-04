import { Type } from '@earendil-works/pi-ai';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';

export function buildAnnounceTool(ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'announce_plan',
    description: '向用户宣告本次任务计划(舞台展示)。在开始一系列写操作(建用例/改环境/配计划等)之前调用:给出一句话总结与步骤清单。',
    parameters: Type.Object({
      summary: Type.String({ minLength: 1, maxLength: 500 }),
      steps: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 20 }),
    }),
    execute: async (input) => {
      const v = input as { summary: string; steps: string[] };
      ctx.emit({ type: 'announce', summary: v.summary, total: v.steps.length, steps: v.steps });
      return { ok: true };
    },
  };
}
