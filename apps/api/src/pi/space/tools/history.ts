/** query_stats:执行历史只读查询(overview/case_stats/failures/report_detail/reports/plan_runs/plan_run_detail)。
 *  项目域范围(含计划成员执行、无版本计划),结果标注版本;汇总优先、按需下钻控制上下文预算。
 *  裁剪(截断/结构化结果整形)在 service 层完成,本工具只做参数解析与序列化。 */
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import * as svc from '../../../services/executionHistory.service.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';

const Actions = z.object({
  action: z.enum(['overview', 'case_stats', 'failures', 'report_detail', 'reports', 'plan_runs', 'plan_run_detail']),
  days: z.number().int().min(1).max(365).optional(),
  versionId: z.string().uuid().optional(),
  caseIds: z.array(z.string().uuid()).max(50).optional(),
  caseId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  status: z.string().min(1).max(20).optional(),
  reportId: z.string().uuid().optional(),
  planId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
});

export function buildHistoryTools(ctx: SpaceToolsContext): ToolExecutor[] {
  return [
    {
      name: 'query_stats',
      description:
        '执行历史查询(只读,当前项目全部历史,含计划成员执行与无版本计划运行)。action=overview(执行总览:总数/双通过率/失败top5/计划运行分布)| case_stats(每用例聚合:执行数/通过/自愈/失败/均耗时,按失败数排序——归因入口)| failures(失败报告明细:reportId/用例/最后断言/所属计划运行)| reports(报告列表,通过+失败都可查:reportId/状态/起止/平台/触发人/所属计划运行——report_detail 的发现入口)| report_detail(reportId,单报告完整详情:步骤时间线含 db/sql/http/syslog/log 结果详情与命中定位/AI 用量,附 preflight/起止时刻/数据行快照/计划运行 RCA)| plan_runs(计划运行列表:状态/通过失败数/版本标注/触发人)| plan_run_detail(runId,单次运行的单用例明细:status/error/耗时/RCA 结论)。days 默认30。',
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal('overview'), Type.Literal('case_stats'), Type.Literal('failures'),
          Type.Literal('report_detail'), Type.Literal('reports'), Type.Literal('plan_runs'),
          Type.Literal('plan_run_detail'),
        ]),
        days: Type.Optional(Type.Number()),
        versionId: Type.Optional(Type.String()),
        caseIds: Type.Optional(Type.Array(Type.String(), { maxItems: 50 })),
        caseId: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number()),
        status: Type.Optional(Type.String()),
        reportId: Type.Optional(Type.String()),
        planId: Type.Optional(Type.String()),
        runId: Type.Optional(Type.String()),
      }),
      promptGuidelines: [
        '归因/统计类问题先 overview 或 case_stats,再按需用 failures / report_detail 下钻;禁止把明细全量贴进回答,汇总优先,用户追问再下钻。',
        '"这个用例最近执行得怎么样/上次通过是什么时候"类问题用 reports(caseId 可选)拿 reportId,再 report_detail 看步骤结果详情——通过的报告也能查。',
        'report_detail 的步骤含五类结构化结果详情:db/sql(命中行)/http(请求响应)/syslog(报文)/log(匹配行),以及 hitLocator(实际命中定位);归因时优先看失败步的这些详情,不要臆测。',
        '计划运行归因:plan_runs 拿 runId → plan_run_detail 看每个用例的 status/error 与 RCA 结论(rca.status=analyzed 才是已分析,timeout 是系统兜底);单报告的 RCA 也可直接从 report_detail.rca 读。',
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
            case 'reports': {
              const rows = await svc.reportList(ctx.projectId, { caseId: v.caseId, status: v.status, days, limit: v.limit });
              if (rows.length === 0) return { ok: true, data: `近 ${days} 天无执行报告` };
              return { ok: true, data: JSON.stringify(rows, null, 2) };
            }
            case 'report_detail': {
              if (!v.reportId) return { ok: false, error: 'report_detail 需要 reportId(可从 failures/reports 结果获取)' };
              const d = await svc.reportDetail(ctx.projectId, v.reportId);
              if (!d) return { ok: false, error: '报告不存在或不属于当前项目' };
              return { ok: true, data: JSON.stringify(d, null, 2) };
            }
            case 'plan_runs': {
              const rows = await svc.planRunList(ctx.projectId, { planId: v.planId, status: v.status, days, limit: v.limit });
              if (rows.length === 0) return { ok: true, data: `近 ${days} 天无计划运行记录` };
              return { ok: true, data: JSON.stringify(rows, null, 2) };
            }
            case 'plan_run_detail': {
              if (!v.runId) return { ok: false, error: 'plan_run_detail 需要 runId(可从 plan_runs 结果获取)' };
              const d = await svc.planRunDetail(ctx.projectId, v.runId);
              if (!d) return { ok: false, error: '计划运行不存在或不属于当前项目' };
              return { ok: true, data: JSON.stringify(d, null, 2) };
            }
          }
        } catch (e) {
          return { ok: false, error: `查询失败:${e instanceof Error ? e.message : String(e)}` };
        }
      },
    },
  ];
}
