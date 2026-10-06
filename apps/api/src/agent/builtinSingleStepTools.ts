/**
 * 单 step 重编译专用 builtin 工具:
 * - getStep: 把现有 step 行(含当前 compiled / instruction)读出来,作为 LLM 上下文 hint
 * - saveSingleStep: 把 LLM 产出的 { compiled: StepAction[] } 落到 compiled 列(同时
 *   把 instruction 写回,如果 LLM 给出),并在 ToolExecutor 回调里把结果存起来给
 *   route 层读取。
 *
 * 与 step.ts(builtinTools.ts)里 createSaveStepsTool/createGetCaseTool 同款形态:
 *   name / description / handler。registerCompileStepResult() 把 saveSingleStep
 *   本次调用的产物缓存,route 层完成后清空,避免多并发污染。
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { StepAction } from '@itest/shared';
import { db } from '../db/client.js';
import { testSteps } from '../db/schema.js';
import { normalizeCompiledStep } from '../pi/tools.js';
import { logger } from '../logger.js';

export interface AgentTool {
  name: string;
  description: string;
  handler: (input: unknown) => Promise<unknown>;
}

type GetStepOutput = {
  ok: true;
  order: number;
  instruction: string | null;
  compiled: unknown[] | null;
} | { ok: false; error: string };

/** saveSingleStep 完成时缓存给 route 层读的产物(落库后的 step row + 校验结果)。 */
interface SaveResult {
  ok: boolean;
  row?: typeof testSteps.$inferSelect;
  error?: string;
}
const lastResults = new Map<string, SaveResult>();

export function consumeSaveResult(stepId: string): SaveResult | undefined {
  const r = lastResults.get(stepId);
  lastResults.delete(stepId);
  return r;
}

/** 读出 stepId 当前 step(给 LLM 当上下文,看已有 compiled 是否能借鉴)。 */
export function createGetStepTool(opts: { stepId: string }): AgentTool {
  return {
    name: 'getStep',
    description: '读取当前要重编译的 step 行（含 instruction / 已编译的 compiled）',
    handler: async () => {
      const rows = await db.select().from(testSteps).where(eq(testSteps.id, opts.stepId)).limit(1);
      const row = rows[0];
      if (!row) return { ok: false, error: 'step not found' };
      const out: GetStepOutput = {
        ok: true,
        order: row.order,
        instruction: row.instruction ?? null,
        compiled: (row.compiled as unknown[] | null) ?? null,
      };
      return out;
    },
  };
}

/** 把 LLM 生成的 { compiled } 落到 test_steps.compiled 列,失败把原因透传。
 *  - compiled=null 表示 LLM 主动放弃 → 透传给前端 toast
 *  - compiled=[] 也视作放弃（防御 LLM 把"放弃"写成空数组） */
const CompiledOutput = z.object({ compiled: z.array(z.unknown()).nullable() });

export function createSaveSingleStepTool(opts: { stepId: string }): AgentTool {
  return {
    name: 'saveSingleStep',
    description: '把 LLM 编出来的 compiled 数组写到 step 行上(compiled 列)',
    handler: async (input) => {
      const parsed = CompiledOutput.safeParse(input);
      if (!parsed.success) {
        const err = `saveSingleStep: 入参不是 {compiled} 形状 (${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})`;
        lastResults.set(opts.stepId, { ok: false, error: err });
        throw new Error(err);
      }
      const raw = parsed.data.compiled;
      if (raw === null || raw.length === 0) {
        const err = 'LLM 放弃编译,无可用 compiled';
        lastResults.set(opts.stepId, { ok: false, error: err });
        throw new Error(err);
      }
      const normalized = raw.map(normalizeCompiledStep);
      const list = z.array(StepAction).min(1).safeParse(normalized);
      if (!list.success) {
        const err = `saveSingleStep: 编译结果不合法 (${list.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})`;
        lastResults.set(opts.stepId, { ok: false, error: err });
        throw new Error(err);
      }
      const [updated] = await db
        .update(testSteps)
        .set({ compiled: list.data as unknown[] })
        .where(eq(testSteps.id, opts.stepId))
        .returning();
      if (!updated) {
        const err = 'saveSingleStep: 落库失败(step 找不到)';
        lastResults.set(opts.stepId, { ok: false, error: err });
        throw new Error(err);
      }
      logger.info({ stepId: opts.stepId, kinds: list.data.map((a) => a.kind) }, 'single step compile saved');
      lastResults.set(opts.stepId, { ok: true, row: updated });
      return { ok: true, id: updated.id, kinds: list.data.map((a) => a.kind) };
    },
  };
}