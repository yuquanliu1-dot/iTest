import { Router } from 'express';
import { eq, desc, inArray, and, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { reports, planRuns, groups, testCases, executionPlans, projectVersions, planRunCases } from '../db/schema.js';
import { assertProjectVisible, visibleProjectIds } from '../services/projectAccess.js';
import { resolveUsersByIds, type ResolvedUser } from '../lib/creator.js';

export const executionsRoute = Router();

/**
 * 计划运行的成员用例执行历史不在此列表展示（点击计划运行行可看其成员用例）：
 * 排除挂在 plan_run_cases.report_id 上的报告、数据集迭代挂在 report_ids 数组中的报告，
 * 以及「正在作为 plan 成员执行」的用例（runCase 一开跑就插 report，report_id 要等用例跑完才
 * 回填——这段瞬态窗口内的 report 无任何 plan 链接，但 plan_run_cases 行以 status=running 先行存在，
 * 据此精确识别。登录用例排在最前跑，正是该窗口最容易让用户在日常监控里看到的那条）。
 *
 * 命中查询与「补齐同批成员」查询共用同一份排除语义（两处漂移会让批成员数对不上）。
 */
const planMemberExclusion = sql`not exists (
  select 1 from ${planRunCases} prc
  where prc.report_id = ${reports.id}
     or exists (
       select 1 from jsonb_array_elements_text(coalesce(prc.report_ids, '[]'::jsonb)) as rid(rid)
       where rid.rid = ${reports.id}::text
     )
     or exists (
       select 1 from ${planRunCases} prc_active
       where prc_active.case_id = ${reports.caseId}
         and prc_active.status = 'running'
     )
)`;

interface CaseEntry {
  kind: 'case';
  id: string;
  caseId: string;
  caseTitle: string | null;
  versionId: string | null;
  versionName: string | null;
  status: string;
  durationMs: number | null;
  summary: string | null;
  /** 最后断言信息：取 step_results 末位元素 —— vision 判定 reason（通过/失败）或失败步 error；无断言为 null。 */
  lastAssertion: string | null;
  /** 自愈通过标记：passed 且 aiTask 缓存分叉后 AI 自愈成功；failed 恒 false。 */
  healed: boolean;
  createdAt: Date | string;
  /** 执行人（即报告创建人 = 触发执行者）；列表统一返回 createdBy。 */
  createdById: string | null;
  createdBy: ResolvedUser | null;
  /** 数据集批次 id（同一次数据集执行的全部行共用）；非数据集执行为 null。 */
  datasetBatchId: string | null;
  /** 本条记录代表的批内成员数（非数据集执行 = 1）。 */
  batchSize: number;
  /** 批内通过 / 失败成员数（按全批真实值算，不受筛选影响）。 */
  batchPassed: number;
  batchFailed: number;
  /** 批内全部成员报告 id（批量删除时展开成 N 条 report 删除）。 */
  memberReportIds: string[];
}

/** 第一遍查询行：命中筛选的 report（含批次键）。 */
interface HitRow {
  id: string;
  caseId: string;
  caseTitle: string | null;
  status: string;
  durationMs: number | null;
  summary: string | null;
  lastAssertion: string | null;
  createdAt: Date;
  healed: boolean;
  createdById: string | null;
  datasetBatchId: string | null;
  datasetRowIndex: number | null;
}

/** 第二遍查询行：同批全部成员（不含筛选条件），用于按整批算统计。 */
interface MemberRow {
  id: string;
  caseId: string;
  status: string;
  durationMs: number | null;
  createdAt: Date;
  healed: boolean;
  createdById: string | null;
  datasetBatchId: string | null;
  datasetRowIndex: number | null;
  summary: string | null;
}
interface PlanEntry {
  kind: 'plan';
  id: string;
  planId: string;
  versionId: string | null;
  versionName: string | null;
  status: string;
  summary: string | null;
  totalCases: number;
  passedCases: number | null;
  failedCases: number | null;
  skippedCases: number | null;
  durationMs: number | null;
  createdAt: Date | string;
  /** 执行人 = 计划运行触发者；列表统一返回 createdBy。 */
  createdById: string | null;
  createdBy: ResolvedUser | null;
  /** 所属计划名（来自 innerJoin executionPlans；理论非空，保 null 兜底） */
  planName: string | null;
}
type Entry = CaseEntry | PlanEntry;

executionsRoute.get('/', async (req, res) => {
  const { projectId, kind = 'all' } = req.query as { projectId?: string; kind?: 'case' | 'plan' | 'all' };
  // 状态 / 版本 / 关键词 facet：statuses / versionIds 走 csv；q 模糊匹配 caseTitle（仅 case 行生效）
  const statusArr = typeof req.query.statuses === 'string' ? req.query.statuses.split(',').filter(Boolean) : [];
  const versionArr = typeof req.query.versionIds === 'string' ? req.query.versionIds.split(',').filter(Boolean) : [];
  const qTrim = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  // 用例 / 计划深链：前端从用例列表或计划列表点「查看报告」时附带，自动过滤
  const caseIdFilter = typeof req.query.caseId === 'string' && req.query.caseId ? req.query.caseId : '';
  const planIdFilter = typeof req.query.planId === 'string' && req.query.planId ? req.query.planId : '';

  if (projectId) await assertProjectVisible(projectId, req.user!);
  // 无 projectId 时按可见项目过滤
  const visiblePids = projectId ? null : await visibleProjectIds(req.user!);

  let caseRows: CaseEntry[] = [];
  let planRows: PlanEntry[] = [];

  if (kind === 'case' || kind === 'all') {
    let gids: string[] = [];
    if (projectId) {
      const gs = await db.select().from(groups).where(eq(groups.projectId, projectId));
      gids = gs.map((g) => g.id);
    } else if (visiblePids && visiblePids.length > 0) {
      const gs = await db.select().from(groups).where(inArray(groups.projectId, visiblePids));
      gids = gs.map((g) => g.id);
    }
    const cs = gids.length ? await db.select({ id: testCases.id, versionId: testCases.versionId }).from(testCases).where(inArray(testCases.groupId, gids)) : [];
    // facet 拼装：版本在 case 侧基于 testCases.versionId，关键词基于 case 标题
    const caseFilters = [
      inArray(reports.caseId, cs.map((c) => c.id)),
      planMemberExclusion,
    ];
    if (statusArr.length) caseFilters.push(inArray(reports.status, statusArr));
    if (versionArr.length) caseFilters.push(inArray(testCases.versionId, versionArr));
    if (qTrim) caseFilters.push(sql`${testCases.title} ilike ${'%' + qTrim + '%'}`);
    if (caseIdFilter) caseFilters.push(eq(reports.caseId, caseIdFilter));
    const hitRows: HitRow[] = cs.length
      ? await db
        .select({
          id: reports.id,
          caseId: reports.caseId,
          caseTitle: testCases.title,
          status: reports.status,
          durationMs: reports.durationMs,
          summary: reports.summary,
          // 最后断言：step_results 数组末位元素 —— vision 通过时 reason 挂在最后一步、vision 失败步追加在末位
          // （order=-1）、普通步骤失败即中断也在末位。coalesce 取 vision reason，否则失败步 error。
          lastAssertion: sql<string | null>`
            case
              when jsonb_typeof(${reports.stepResults}) = 'array' and jsonb_array_length(${reports.stepResults}) > 0 then
                (select coalesce(
                   e -> 'visionAssert' ->> 'reason',
                   case when e ->> 'status' = 'failed' then e ->> 'error' end
                 )
                 from jsonb_array_elements(${reports.stepResults}) with ordinality as t(e, ord)
                 order by ord desc
                 limit 1)
              else null
            end`,
          createdAt: reports.createdAt,
          healed: reports.healed,
          createdById: reports.createdByUserId,
          datasetBatchId: reports.datasetBatchId,
          datasetRowIndex: reports.datasetRowIndex,
        })
        .from(reports)
        .leftJoin(testCases, eq(testCases.id, reports.caseId))
        .where(and(...caseFilters))
        .orderBy(desc(reports.createdAt))
      : [];

    // 数据集批次卷起：一次数据集执行 = N 条 report（同 dataset_batch_id），列表里应像计划运行一样
    // 只占一行。第一遍只拿到「命中筛选」的成员；这里再查一次同批的全部成员（不含筛选条件），
    // 让统计口径（批内通过/失败数、耗时、状态）按整批真实值算，而不是按命中的那几行算。
    const hitBatchIds = Array.from(new Set(hitRows.map((r) => r.datasetBatchId).filter((v): v is string => !!v)));
    const membersByBatch = new Map<string, MemberRow[]>();
    if (hitBatchIds.length && cs.length) {
      const memberRows = await db
        .select({
          id: reports.id,
          caseId: reports.caseId,
          status: reports.status,
          durationMs: reports.durationMs,
          createdAt: reports.createdAt,
          healed: reports.healed,
          createdById: reports.createdByUserId,
          datasetBatchId: reports.datasetBatchId,
          datasetRowIndex: reports.datasetRowIndex,
          summary: reports.summary,
        })
        .from(reports)
        .where(and(
          inArray(reports.datasetBatchId, hitBatchIds),
          inArray(reports.caseId, cs.map((c) => c.id)),
          planMemberExclusion,
        ));
      for (const m of memberRows) {
        if (!m.datasetBatchId) continue;
        const arr = membersByBatch.get(m.datasetBatchId) ?? [];
        arr.push(m);
        membersByBatch.set(m.datasetBatchId, arr);
      }
    }

    const emittedBatches = new Set<string>();
    caseRows = [];
    for (const h of hitRows) {
      const c = cs.find((x) => x.id === h.caseId);
      const base = { ...h, versionId: c?.versionId ?? null, versionName: null, kind: 'case' as const };
      if (!h.datasetBatchId) {
        caseRows.push({
          ...base,
          datasetBatchId: null,
          batchSize: 1,
          batchPassed: h.status === 'passed' ? 1 : 0,
          batchFailed: h.status === 'failed' ? 1 : 0,
          memberReportIds: [h.id],
          // 执行人在 merge 阶段批量解析后回填
          createdBy: null,
        });
        continue;
      }
      if (emittedBatches.has(h.datasetBatchId)) continue; // 同一批只出一行
      emittedBatches.add(h.datasetBatchId);
      const members = membersByBatch.get(h.datasetBatchId) ?? [h];
      // 成员按行号升序（并列按落库时间）——锚点取第一个，memberReportIds 也按这个序展开
      const ordered = [...members].sort((a, b) => {
        const ia = a.datasetRowIndex ?? Number.MAX_SAFE_INTEGER;
        const ib = b.datasetRowIndex ?? Number.MAX_SAFE_INTEGER;
        if (ia !== ib) return ia - ib;
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });
      // 锚点 = 行号最小者（并列取最早落库）：点进详情页即落在批次第一行，行切换器随之就绪
      const anchor = ordered[0]!;
      const anyRunning = members.some((m) => m.status === 'running');
      const allPassed = members.every((m) => m.status === 'passed');
      const rolledStatus = anyRunning ? 'running' : allPassed ? 'passed' : 'failed';
      const multi = members.length > 1;
      caseRows.push({
        ...base,
        id: anchor.id,
        status: rolledStatus,
        durationMs: members.reduce((sum, m) => sum + (m.durationMs ?? 0), 0),
        summary: anchor.summary,
        // 单行批次保留断言文案；多行批次单行断言对整批无意义，改由通过/失败计数表达
        lastAssertion: multi ? null : h.lastAssertion,
        healed: rolledStatus === 'passed' && members.some((m) => m.healed),
        createdAt: members.reduce((mx, m) => (new Date(m.createdAt).getTime() > new Date(mx).getTime() ? m.createdAt : mx), anchor.createdAt),
        createdById: anchor.createdById ?? h.createdById,
        datasetBatchId: h.datasetBatchId,
        batchSize: members.length,
        batchPassed: members.filter((m) => m.status === 'passed').length,
        batchFailed: members.filter((m) => m.status === 'failed').length,
        memberReportIds: ordered.map((m) => m.id),
        // 执行人在 merge 阶段批量解析后回填
        createdBy: null,
      });
    }

    const vIds = Array.from(new Set(caseRows.map((r) => r.versionId).filter((v): v is string => !!v)));
    if (vIds.length) {
      const vrs = await db.select().from(projectVersions).where(inArray(projectVersions.id, vIds));
      const vName = new Map(vrs.map((v) => [v.id, v.name] as const));
      caseRows = caseRows.map((r) => ({ ...r, versionName: r.versionId ? vName.get(r.versionId) ?? null : null }));
    }
  }

  if (kind === 'plan' || kind === 'all') {
    const conds = projectId
      ? [eq(planRuns.projectId, projectId)]
      : visiblePids && visiblePids.length > 0
        ? [inArray(planRuns.projectId, visiblePids)]
        : [];
    if (statusArr.length) conds.push(inArray(planRuns.status, statusArr));
    // plan 行的 versionId 来自 executionPlans.versionId
    if (versionArr.length) conds.push(inArray(executionPlans.versionId, versionArr));
    if (planIdFilter) conds.push(eq(planRuns.planId, planIdFilter));
    // caseId 深链在 plan tab 上继续生效（否则 URL 里的 caseId 静默失效、切 tab 后退化成全项目计划列表）：
    // 取「把该用例作为成员跑过」的计划运行。这样切到 plan tab 恰好能定位到 case 分支里被
    // not exists 排除掉的那批报告——用例详情页深链最常见的落点就是它们。
    if (caseIdFilter) {
      conds.push(
        inArray(
          planRuns.id,
          db.select({ planRunId: planRunCases.planRunId }).from(planRunCases).where(eq(planRunCases.caseId, caseIdFilter)),
        ),
      );
    }
    const where = conds.length ? and(...conds) : undefined;
    const rows = where
      ? await db
          .select({ id: planRuns.id, planId: planRuns.planId, planName: executionPlans.name, status: planRuns.status, summary: planRuns.summary, totalCases: planRuns.totalCases, passedCases: planRuns.passedCases, failedCases: planRuns.failedCases, skippedCases: planRuns.skippedCases, durationMs: planRuns.durationMs, startedAt: planRuns.startedAt, versionId: executionPlans.versionId, createdById: planRuns.triggeredByUserId })
          .from(planRuns)
          .innerJoin(executionPlans, eq(executionPlans.id, planRuns.planId))
          .where(where)
          .orderBy(desc(planRuns.startedAt))
      : [];
    planRows = rows.map((r) => ({
      kind: 'plan' as const,
      id: r.id,
      planId: r.planId,
      planName: r.planName ?? null,
      versionId: r.versionId ?? null,
      versionName: null,
      status: r.status,
      summary: r.summary,
      totalCases: r.totalCases,
      passedCases: r.passedCases,
      failedCases: r.failedCases,
      skippedCases: r.skippedCases,
      durationMs: r.durationMs,
      createdAt: r.startedAt,
      createdById: r.createdById ?? null,
      // 执行人统一在 merge 阶段批量解析后回填
      createdBy: null,
    }));
    const pVids = Array.from(new Set(planRows.map((r) => r.versionId).filter((v): v is string => !!v)));
    if (pVids.length) {
      const vrs = await db.select().from(projectVersions).where(inArray(projectVersions.id, pVids));
      const vName = new Map(vrs.map((v) => [v.id, v.name] as const));
      planRows = planRows.map((r) => ({ ...r, versionName: r.versionId ? vName.get(r.versionId) ?? null : null }));
    }
  }

  const actorIds = Array.from(
    new Set([...caseRows, ...planRows].map((r) => r.createdById).filter((v): v is string => !!v)),
  );
  const actorMap = await resolveUsersByIds(actorIds);
  const merged: Entry[] = [...caseRows, ...planRows]
    .map((r) => ({ ...r, createdBy: r.createdById ? (actorMap.get(r.createdById) ?? null) : null }))
    .sort((a, b) => {
      const ta = new Date(a.createdAt).getTime();
      const tb = new Date(b.createdAt).getTime();
      return tb - ta;
    });
  res.json(merged);
});
