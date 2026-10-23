/** save_rca_result:RCA 线程专用——把单个失败用例的分析结论写入 plan_run_cases.rca。
 *  仅 purpose='rca' 的线程注册(buildSpaceTools 闸门);status='timeout' 保留给 worker 兜底,AI 不可用。 */
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { planRunCases } from '../../../db/schema.js';
import { cache } from '../../../lib/cache.js';
import { planRunDetailKey } from '../../../lib/cache-keys.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';

const Args = z.object({
  planRunCaseId: z.string().uuid(),
  status: z.enum(['analyzed', 'skipped', 'error']),
  category: z.enum(['system_defect', 'case_issue', 'environment', 'other']),
  confidence: z.enum(['high', 'medium', 'low']),
  summary: z.string().min(1).max(4000),
  evidence: z.array(z.object({
    file: z.string().min(1),
    lines: z.string().max(40).optional(),
    note: z.string().max(500).optional(),
  })).max(20).optional(),
  suggestion: z.string().max(4000).optional(),
});

export function buildSaveRcaResultTool(ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'save_rca_result',
    description:
      '保存一个失败用例的根因分析结论(每个失败用例恰好调用一次)。系统缺陷:status=analyzed+evidence+suggestion;非系统缺陷:status=skipped,summary 一句话结论;报告数据不可得:status=error 并说明原因。',
    parameters: Type.Object({
      planRunCaseId: Type.String({ description: '失败用例清单里的 planRunCaseId' }),
      status: Type.Union([Type.Literal('analyzed'), Type.Literal('skipped'), Type.Literal('error')]),
      category: Type.Union([
        Type.Literal('system_defect'), Type.Literal('case_issue'),
        Type.Literal('environment'), Type.Literal('other'),
      ]),
      confidence: Type.Union([Type.Literal('high'), Type.Literal('medium'), Type.Literal('low')]),
      summary: Type.String({ description: '根因/结论描述' }),
      evidence: Type.Optional(Type.Array(Type.Object({
        file: Type.String(), lines: Type.Optional(Type.String()), note: Type.Optional(Type.String()),
      }), { maxItems: 20 })),
      suggestion: Type.Optional(Type.String()),
    }),
    promptGuidelines: [
      '每个失败用例恰好调用一次;status=timeout 是系统保留值,禁止使用。',
      '系统缺陷必须给出至少一条 evidence(代码仓 file:line);非系统缺陷不写 evidence。',
    ],
    execute: async (input) => {
      let v: z.infer<typeof Args>;
      try {
        v = Args.parse(input);
      } catch (e) {
        if (e instanceof z.ZodError) {
          return { ok: false, error: `参数不合法:${e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}` };
        }
        throw e;
      }
      const row = (await db.select({ id: planRunCases.id, planRunId: planRunCases.planRunId }).from(planRunCases).where(eq(planRunCases.id, v.planRunCaseId)).limit(1))[0];
      if (!row) return { ok: false, error: `planRunCaseId 不存在: ${v.planRunCaseId}` };
      const { planRunCaseId, ...rca } = v;
      void planRunCaseId;
      await db.update(planRunCases).set({
        rca: { ...rca, analyzedAt: new Date().toISOString(), threadId: ctx.threadId },
      }).where(eq(planRunCases.id, v.planRunCaseId));
      // 终态 run 详情缓存里有 cases[].rca,结论落库后失效让前端立即可见
      await cache.del(planRunDetailKey(row.planRunId));
      return { ok: true, data: `已保存 ${v.planRunCaseId.slice(0, 8)} 的分析结论(${v.status}/${v.category})` };
    },
  };
}
