/** query_stats:执行历史只读查询(overview/case_stats/failures/report_detail/plan_runs)。
 *  项目域范围(含计划成员执行、无版本计划),结果标注版本;汇总优先、按需下钻控制上下文预算。 */
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import * as svc from '../../../services/executionHistory.service.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';

const Actions = z.object({
  action: z.enum(['overview', 'case_stats', 'failures', 'report_detail', 'plan_runs']),
  days: z.number().int().min(1).max(365).optional(),
  versionId: z.string().uuid().optional(),
  caseIds: z.array(z.string().uuid()).max(50).optional(),
  caseId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  status: z.string().min(1).max(20).optional(),
  reportId: z.string().uuid().optional(),
  planId: z.string().uuid().optional(),
});

/** 长文本截断(上下文预算):error 类字段超 500 字截断加省略号。 */
function clipSteps<T extends { error?: string; humanMessage?: string; visionAssertReason?: string }>(steps: T[]): T[] {
  const clip = (s: string) => (s.length > 500 ? `${s.slice(0, 500)}…` : s);
  return steps.map((st) => ({
    ...st,
    ...(st.error ? { error: clip(st.error) } : {}),
    ...(st.humanMessage ? { humanMessage: clip(st.humanMessage) } : {}),
    ...(st.visionAssertReason ? { visionAssertReason: clip(st.visionAssertReason) } : {}),
  }));
}

export function buildHistoryTools(ctx: SpaceToolsContext): ToolExecutor[] {
  void ctx; // 只读工具,当前仅用 ctx.projectId;留参数保持家族签名一致
  return [
    {
      name: 'query_stats',
      description:
        '执行历史查询(只读,当前项目全部历史,含计划成员执行与无版本计划)。action=overview(执行总览:总数/双通过率/失败top5/计划运行分布)| case_stats(每用例聚合:执行数/通过/自愈/失败/均耗时,按失败数排序——归因入口)| failures(失败报告明细:reportId/用例/最后断言/所属计划运行)| report_detail(reportId,单报告步骤时间线——深度归因)| plan_runs(计划运行列表:状态/通过失败数/版本标注/触发人)。days 默认30。',
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal('overview'), Type.Literal('case_stats'), Type.Literal('failures'),
          Type.Literal('report_detail'), Type.Literal('plan_runs'),
        ]),
        days: Type.Optional(Type.Number()),
        versionId: Type.Optional(Type.String()),
        caseIds: Type.Optional(Type.Array(Type.String(), { maxItems: 50 })),
        caseId: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number()),
        status: Type.Optional(Type.String()),
        reportId: Type.Optional(Type.String()),
        planId: Type.Optional(Type.String()),
      }),
      promptGuidelines: [
        '归因/统计类问题先 overview 或 case_stats,再按需用 failures / report_detail 下钻;禁止把明细全量贴进回答,汇总优先,用户追问再下钻。',
        '结果可能含其他版本的数据:回答时标注每条的所属版本(versionName 为 null 的计划运行标注"无版本")。',
        '"最近"未指明天数时按 7 天查询并在回答中说明;days 上限 365。',
        '生成测试报告用固定骨架:# <项目> 测试报告(<时间范围>)/ 1 概览(执行数、通过率、环比)/ 2 失败清单(按失败数排序,含版本标注)/ 3 计划运行状况 / 4 发现与建议——第4节结论必须源自查询到的数据,禁止臆测。',
        '通过率口径:passed=一次通过,healed=自愈通过,通过率=(passed+healed)/total;回答时分开说明,别把自愈混成一次通过。',
        'failures 返回的 lastAssertion 优先是用例级视觉判定理由(visionAssert.reason),否则是失败步错误;planRunId 非空说明该次执行发生在计划运行里。',
      ],
      execute: async (input) => {
        let v: z.infer<typeof Actions>;
        try {
          v = Actions.parse(input);
        } catch (e) {
          if (e instanceof z.ZodError) {
            return { ok: false, error: `参数不合法:${e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}` };
          }
          throw e;
        }
        const days = v.days ?? 30;
        try {
          switch (v.action) {
            case 'overview': {
              const ov = await svc.historyOverview(ctx.projectId, { days, versionId: v.versionId });
              if (ov.caseReports.total === 0 && ov.planRuns.total === 0) {
                return { ok: true, data: `近 ${days} 天无执行历史(当前项目)` };
              }
              return { ok: true, data: JSON.stringify(ov, null, 2) };
            }
            case 'case_stats': {
              const rows = await svc.caseStats(ctx.projectId, { caseIds: v.caseIds, versionId: v.versionId, days });
              if (rows.length === 0) return { ok: true, data: `近 ${days} 天无用例执行记录` };
              return { ok: true, data: JSON.stringify(rows, null, 2) };
            }
            case 'failures': {
              const rows = await svc.failureList(ctx.projectId, { caseId: v.caseId, days, limit: v.limit });
              if (rows.length === 0) return { ok: true, data: `近 ${days} 天无失败记录` };
              return { ok: true, data: JSON.stringify(rows, null, 2) };
            }
            case 'report_detail': {
              if (!v.reportId) return { ok: false, error: 'report_detail 需要 reportId(可从 failures 结果获取)' };
              const d = await svc.reportDetail(ctx.projectId, v.reportId);
              if (!d) return { ok: false, error: '报告不存在或不属于当前项目' };
              return { ok: true, data: JSON.stringify({ ...d, steps: clipSteps(d.steps) }, null, 2) };
            }
            case 'plan_runs': {
              const rows = await svc.planRunList(ctx.projectId, { planId: v.planId, status: v.status, days, limit: v.limit });
              if (rows.length === 0) return { ok: true, data: `近 ${days} 天无计划运行记录` };
              return { ok: true, data: JSON.stringify(rows, null, 2) };
            }
          }
        } catch (e) {
          return { ok: false, error: `查询失败:${e instanceof Error ? e.message : String(e)}` };
        }
      },
    },
  ];
}
