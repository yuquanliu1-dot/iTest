/** 执行历史查询 service(query_stats 工具的数据层)。
 *  范围语义:项目域——当前项目全部执行历史(含计划成员执行、无版本计划运行),结果标注所属版本。
 *  与 executions 列表页的"展示口径"(排除计划成员)不同:归因口径关注用例本身全历史。
 *  只读,无写路径。 */
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { executionPlans, groups, planRuns, projectVersions, reports, testCases } from '../db/schema.js';
import { resolveUsersByIds } from '../lib/creator.js';

/** days 天前的时间点(含当天当天,闭区间起点)。 */
function since(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

/** 失败计数片段(orderBy 复用;必须括号包住 filter 再 ::int,否则 pg 返回 bigint→string) */
const failedCount = sql`(count(*) filter (where ${reports.status} = 'failed'))`;

export interface HistoryCaseStat {
  caseId: string;
  caseTitle: string;
  versionId: string;
  versionName: string | null;
  total: number;
  passed: number;
  healed: number;
  failed: number;
  avgDurationMs: number | null;
  lastStatus: string | null;
  lastRunAt: string | null;
}

/** 用例级聚合:执行数/通过(含自愈拆分)/失败/均耗时/最新状态,按失败数降序。含计划成员执行。 */
export async function caseStats(
  projectId: string,
  opts: { caseIds?: string[]; versionId?: string; days?: number } = {},
): Promise<HistoryCaseStat[]> {
  const conds = [eq(groups.projectId, projectId), gte(reports.createdAt, since(opts.days ?? 30))];
  if (opts.caseIds?.length) conds.push(inArray(reports.caseId, opts.caseIds));
  if (opts.versionId) conds.push(eq(testCases.versionId, opts.versionId));
  const rows = await db
    .select({
      caseId: testCases.id,
      caseTitle: testCases.title,
      versionId: testCases.versionId,
      total: sql<number>`(count(*))::int`,
      passed: sql<number>`(count(*) filter (where ${reports.status} = 'passed' and ${reports.healed} = false))::int`,
      healed: sql<number>`(count(*) filter (where ${reports.status} = 'passed' and ${reports.healed} = true))::int`,
      failed: sql<number>`${failedCount}::int`,
      avgDurationMs: sql<number | null>`(avg(${reports.durationMs}))::int`,
      lastStatus: sql<string | null>`(array_agg(${reports.status} order by ${reports.createdAt} desc))[1]`,
      lastRunAt: sql<string | null>`(max(${reports.createdAt}))::text`,
    })
    .from(reports)
    .innerJoin(testCases, eq(testCases.id, reports.caseId))
    .innerJoin(groups, eq(groups.id, testCases.groupId))
    .where(and(...conds))
    .groupBy(testCases.id, testCases.title, testCases.versionId)
    .orderBy(desc(failedCount));
  return attachVersionNames(rows);
}

/** 批量给行补 versionName(null versionId → null,由上层标注"无版本")。 */
async function attachVersionNames<T extends { versionId: string | null }>(
  rows: T[],
): Promise<Array<T & { versionName: string | null }>> {
  const ids = [...new Set(rows.map((r) => r.versionId).filter((v): v is string => !!v))];
  const map = new Map<string, string>();
  if (ids.length) {
    const vs = await db
      .select({ id: projectVersions.id, name: projectVersions.name })
      .from(projectVersions)
      .where(inArray(projectVersions.id, ids));
    for (const v of vs) map.set(v.id, v.name);
  }
  return rows.map((r) => ({ ...r, versionName: r.versionId ? (map.get(r.versionId) ?? null) : null }));
}
