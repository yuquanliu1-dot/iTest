import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { StepAction } from '@itest/shared';
import { db } from '../db/client.js';
import { testCases, testSteps } from '../db/schema.js';

export interface AgentTool {
  name: string;
  description: string;
  handler: (input: unknown) => Promise<unknown>;
}

const StepItem = z.object({ order: z.number(), action: StepAction });
const CasesOutput = z.object({
  cases: z.array(
    z.object({
      title: z.string(),
      description: z.string().optional(),
      priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
      steps: z.array(StepItem).optional(),
    }),
  ),
});
const StepsOutput = z.object({ steps: z.array(StepItem) });

/** 保存 LLM 输出的用例集：逐条插入 test_cases（可带步骤）。输入不符合形状时抛错终止 run。 */
export function createSaveCaseTool(opts: { requirementId: string; groupId: string }): AgentTool {
  return {
    name: 'saveCase',
    description: '保存生成的测试用例到数据库',
    handler: async (input) => {
      const { cases } = CasesOutput.parse(input);
      const caseIds: string[] = [];
      for (const c of cases) {
        const rows = await db
          .insert(testCases)
          .values({
            requirementId: opts.requirementId,
            groupId: opts.groupId,
            title: c.title,
            description: c.description,
            priority: c.priority ?? 'P1',
          })
          .returning();
        const caseId = rows[0]!.id;
        caseIds.push(caseId);
        if (c.steps && c.steps.length > 0) {
          await db.insert(testSteps).values(
            c.steps.map((s) => ({
              caseId,
              order: s.order,
              source: 'agent' as const,
              action: s.action as object,
            })),
          );
        }
      }
      return { ok: true, caseIds };
    },
  };
}

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
