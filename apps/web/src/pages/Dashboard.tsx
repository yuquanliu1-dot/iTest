import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../stores/auth';
import { useOverviewQuery, overviewQueryKey, type Range } from '../features/overview/api';
import { formatDuration, formatPct } from '../features/overview/format';
import OverviewHeader from '../features/overview/components/OverviewHeader';
import OverviewSkeleton from '../features/overview/components/OverviewSkeleton';
import OverviewEmpty from '../features/overview/components/OverviewEmpty';
import KpiStripCard from '../features/overview/components/KpiStripCard';
import WorkbenchShell from '../features/overview/components/WorkbenchShell';
import PassRateTrendChart from '../features/overview/components/PassRateTrendChart';
import ExecutionOverviewCard from '../features/overview/components/ExecutionOverviewCard';
import RcaDistributionCard from '../features/overview/components/RcaDistributionCard';
import RequirementCoverageCard from '../features/overview/components/RequirementCoverageCard';
import TopFailuresChart from '../features/overview/components/TopFailuresChart';
import PlanOverviewTable from '../features/overview/components/PlanOverviewTable';
import RecordingActivityChart from '../features/overview/components/RecordingActivityChart';
import AiUsageChart from '../features/overview/components/AiUsageChart';
import { PageShell, PageShellContent } from '../components/layout/PageShell';

export default function Dashboard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { projectId, versionId: vidParam } = useParams<{ projectId: string; versionId?: string }>();
  const versionId = vidParam ?? null;
  const [range, setRange] = useState<Range>('7d');
  const { data, isLoading, isError } = useOverviewQuery(projectId, range);
  const user = useAuthStore((s) => s.user);

  if (!projectId) return null;

  const days = range === '7d' ? 7 : 30;

  if (isError) {
    return (
      <WorkbenchShell>
        <PageShell>
          <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--muted-foreground)', fontSize: 13 }}>
            {t('overview:loadFailed')}
          </div>
        </PageShell>
      </WorkbenchShell>
    );
  }

  if (isLoading || !data) {
    return (
      <WorkbenchShell>
        <OverviewSkeleton />
      </WorkbenchShell>
    );
  }

  const isEmpty = data.kpi.totalCases === 0 && data.kpi.totalPlans === 0 && data.kpi.totalRuns7d === 0;

  const refresh = () => qc.invalidateQueries({ queryKey: overviewQueryKey(projectId, range) });

  if (isEmpty) {
    return (
      <WorkbenchShell>
        <PageShell>
          <OverviewHeader range={range} onRangeChange={setRange} onRefresh={refresh} />
          <PageShellContent>
            <OverviewEmpty projectId={projectId} />
          </PageShellContent>
        </PageShell>
      </WorkbenchShell>
    );
  }

  const latestReportByCase = new Map<string, string>();
  for (const r of data.recentRuns) {
    if (r.kind === 'case' && !latestReportByCase.has(r.caseId)) {
      latestReportByCase.set(r.caseId, r.id);
    }
  }

  // 内部链接在带版本上下文时使用版本化路由，否则回退到首页选项目
  const link = (path: string) =>
    versionId ? `/p/${projectId}/v/${versionId}${path}` : `/`;

  return (
    <WorkbenchShell>
      <PageShell>
        <OverviewHeader
          range={range}
          onRangeChange={setRange}
          onRefresh={refresh}
          summary={{
            name: user?.displayName || user?.username || 'admin',
            days,
            runs: data.kpi.totalRuns7d,
            passRate: formatPct(data.kpi.passRate),
            firstPassRate: formatPct(data.kpi.firstPassRate),
            healed: data.kpi.aiHealedReports7d,
          }}
        />

        {/* KPI strip — 5 cards */}
        <div className="grid grid-cols-5 gap-4 fade-up" data-stagger>
          <KpiStripCard
            label={t('overview:kpiTotalCases')}
            value={data.kpi.totalCases.toLocaleString()}
            iconName="beaker"
            tone="var(--primary)"
            to={link('/groups')}
            footLabel={t('overview:kpiFootReqLinked', {
              linked: data.coverage.linkedCases,
              total: data.coverage.totalCases,
            })}
          />
          <KpiStripCard
            label={t('overview:kpiSolidify')}
            value={formatPct(data.kpi.solidifyRate)}
            suffix="%"
            iconName="bolt"
            tone="var(--info)"
            to={link('/groups')}
            footLabel={t('overview:kpiFootPendingSteps', { count: data.kpi.solidifyPendingSteps })}
          />
          <KpiStripCard
            label={t('overview:kpiFinalPass')}
            value={formatPct(data.kpi.passRate)}
            suffix="%"
            iconName="checkCircle"
            tone="var(--success)"
            to={link('/reports?filter=passed-7d')}
            footLabel={t('overview:kpiFootFirstPass', { value: formatPct(data.kpi.firstPassRate) })}
          />
          <KpiStripCard
            label={t('overview:kpiRuns')}
            value={data.kpi.totalRuns7d.toLocaleString()}
            iconName="activity"
            tone="var(--chart-4)"
            to={link('/reports')}
            footLabel={t('overview:kpiFootP95', { value: formatDuration(data.kpi.p95DurationMs) })}
          />
          <KpiStripCard
            label={t('overview:kpiAiCalls')}
            value={data.kpi.aiCalls7d.toLocaleString()}
            iconName="sparkles"
            tone="var(--chart-3)"
            to={link('/reports')}
            footLabel={t('overview:kpiFootHealed', { count: data.kpi.aiHealedReports7d })}
          />
        </div>

        {/* Row: trend (8) + execution overview (4) */}
        <div className="grid grid-cols-12 gap-4 fade-up">
          <div className="col-span-8">
            <PassRateTrendChart data={data.trend} />
          </div>
          <div className="col-span-4">
            <ExecutionOverviewCard
              days={days}
              executions={data.executions}
              totalRuns={data.kpi.totalRuns7d}
              p95DurationMs={data.kpi.p95DurationMs}
              solidifyPendingSteps={data.kpi.solidifyPendingSteps}
              solidifyPendingAiTasks={data.kpi.solidifyPendingAiTasks}
              topFailures={data.topFailures}
              rca={data.rca}
            />
          </div>
        </div>

        {/* Row: RCA / coverage / top failures */}
        <div className="grid grid-cols-12 gap-4 fade-up">
          <div className="col-span-4">
            <RcaDistributionCard days={days} rca={data.rca} />
          </div>
          <div className="col-span-4">
            <RequirementCoverageCard coverage={data.coverage} />
          </div>
          <div className="col-span-4">
            <TopFailuresChart
              data={data.topFailures}
              days={days}
              latestReportByCase={latestReportByCase}
              projectId={projectId}
            />
          </div>
        </div>

        {/* Row: plans table */}
        <div className="fade-up">
          <PlanOverviewTable
            plans={data.plans}
            schedulesCount={data.schedules.enabledCount}
            projectId={projectId}
          />
        </div>

        {/* Row: recording + AI usage */}
        <div className="grid grid-cols-12 gap-4 fade-up">
          <div className="col-span-6">
            <RecordingActivityChart data={data.recordingActivity} />
          </div>
          <div className="col-span-6">
            <AiUsageChart data={data.aiUsage} days={days} />
          </div>
        </div>
      </PageShell>
    </WorkbenchShell>
  );
}
