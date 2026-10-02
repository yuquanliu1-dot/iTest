import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useOverviewQuery, overviewQueryKey, type Range } from '../features/overview/api';
import OverviewHeader from '../features/overview/components/OverviewHeader';
import OverviewSkeleton from '../features/overview/components/OverviewSkeleton';
import OverviewEmpty from '../features/overview/components/OverviewEmpty';
import KpiStripCard from '../features/overview/components/KpiStripCard';
import PassRateTrendChart from '../features/overview/components/PassRateTrendChart';
import TopFailuresChart from '../features/overview/components/TopFailuresChart';
import PriorityDonut from '../features/overview/components/PriorityDonut';
import PlanStatusLine from '../features/overview/components/PlanStatusLine';
import RecentRunsStream from '../features/overview/components/RecentRunsStream';
import RecordingActivityChart from '../features/overview/components/RecordingActivityChart';
import AiActivityChart from '../features/overview/components/AiActivityChart';

export default function Dashboard() {
  const qc = useQueryClient();
  const { projectId } = useParams<{ projectId: string }>();
  const [range, setRange] = useState<Range>('7d');
  const { data, isLoading, isError } = useOverviewQuery(projectId, range);

  if (!projectId) return null;

  if (isError) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)', fontSize: 13 }}>
        概览暂时不可用,请稍后重试
      </div>
    );
  }

  if (isLoading || !data) return <OverviewSkeleton />;

  const isEmpty = data.kpi.totalCases === 0 && data.kpi.totalPlans === 0 && data.kpi.totalRuns7d === 0;

  const refresh = () => qc.invalidateQueries({ queryKey: overviewQueryKey(projectId, range) });

  if (isEmpty) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div>
          <OverviewHeader range={range} onRangeChange={setRange} onRefresh={refresh} />
        </div>
        <OverviewEmpty projectId={projectId} />
      </div>
    );
  }

  const latestReportByCase = new Map<string, string>();
  for (const r of data.recentRuns) {
    if (r.kind === 'case' && !latestReportByCase.has(r.caseId)) {
      latestReportByCase.set(r.caseId, r.id);
    }
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div>
        <OverviewHeader range={range} onRangeChange={setRange} onRefresh={refresh} />
      </div>

      {/* KPI strip — 5 cards */}
      <div className="grid grid-cols-5 gap-4 px-5 pt-4 fade-up" data-stagger>
        <KpiStripCard
          label="用例总数"
          value={data.kpi.totalCases}
          iconName="beaker"
          tone="var(--color-info)"
          to={`/p/${projectId}/groups`}
        />
        <KpiStripCard
          label="计划数"
          value={data.kpi.totalPlans}
          iconName="flag"
          tone="var(--color-accent)"
          to={`/p/${projectId}/plans`}
        />
        <KpiStripCard
          label="通过率"
          value={Math.round(data.kpi.passRate * 100)}
          suffix="%"
          iconName="checkCircle"
          tone="var(--color-success)"
          to={`/p/${projectId}/reports`}
        />
        <KpiStripCard
          label="近 7d 运行"
          value={data.kpi.totalRuns7d}
          iconName="activity"
          tone="var(--color-warning)"
          to={`/p/${projectId}/reports`}
        />
        <KpiStripCard
          label="AI 调用"
          value={data.kpi.aiCalls7d}
          iconName="sparkles"
          tone="var(--color-chart-5)"
          to={`/p/${projectId}/groups`}
        />
      </div>

      {/* Main grid — charts left, activity right */}
      <div className="grid grid-cols-12 gap-4 px-5 pt-4 fade-up" data-stagger>
        <div className="col-span-8 flex flex-col gap-4">
          <PassRateTrendChart data={data.trend} />
          <div className="grid grid-cols-2 gap-4">
            <TopFailuresChart
              data={data.topFailures}
              latestReportByCase={latestReportByCase}
              projectId={projectId}
            />
            <PriorityDonut data={data.priorityDistribution} />
          </div>
        </div>
        <div className="col-span-4 flex flex-col gap-4">
          <RecentRunsStream runs={data.recentRuns} projectId={projectId} />
          <PlanStatusLine plans={data.plans} projectId={projectId} />
        </div>
      </div>

      {/* Bottom row — recording + AI activity */}
      <div className="grid grid-cols-12 gap-4 px-5 pt-4 pb-5 fade-up" data-stagger>
        <div className="col-span-6">
          <RecordingActivityChart data={data.recordingActivity} />
        </div>
        <div className="col-span-6">
          <AiActivityChart data={data.aiActivity} />
        </div>
      </div>
    </div>
  );
}
