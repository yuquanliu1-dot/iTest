import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { StepAction } from '@itest/shared';
import { db } from '../db/client.js';
import { testSteps } from '../db/schema.js';

export interface AgentTool {
  name: string;
  description: string;
  handler: (input: unknown) => Promise<unknown>;
}

const StepItem = z.object({ order: z.number(), action: StepAction });
const StepsOutput = z.object({ steps: z.array(StepItem) });

/** 保存 LLM 生成的脚本步骤到指定用例。 */
export function createSaveStepsTool(opts: { caseId: string }): AgentTool {
  return {
    name: 'saveSteps',
    description: '保存生成的步骤',
    handler: async (input) => {
      const { steps } = StepsOutput.parse(input);
      if (steps.length === 0) return { ok: true, inserted: 0 };
      await db.insert(testSteps).values(
        steps.map((s) => ({
          caseId: opts.caseId,
          order: s.order,
          source: 'agent' as const,
          action: s.action as object,
        })),
      );
      return { ok: true, inserted: steps.length };
    },
  };
}

/** 读取用例当前步骤，供后续步骤/提示词使用。 */
export function createGetCaseTool(opts: { caseId: string }): AgentTool {
  return {
    name: 'getCase',
    description: '获取用例当前步骤',
    handler: async () => {
      const rows = await db
        .select()
        .from(testSteps)
        .where(eq(testSteps.caseId, opts.caseId))
        .orderBy(testSteps.order);
      return { ok: true, steps: rows.map((r) => ({ order: r.order, action: r.action })) };
    },
  };
}
