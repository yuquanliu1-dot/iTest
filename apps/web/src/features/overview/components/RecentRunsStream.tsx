import { useNavigate } from 'react-router-dom';
import StatusPill from '../../../components/ui/StatusPill';
import EmptyState from '../../../components/ui/EmptyState';
import type { OverviewResponse } from '../api';

type Run = OverviewResponse['recentRuns'][number];

export default function RecentRunsStream({ runs, projectId }: { runs: Run[]; projectId: string }) {
  const navigate = useNavigate();

  return (
    <div
      className="glass-panel rounded-[var(--radius-md)] p-5 flex flex-col"
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <h3 className="text-[14px] font-semibold mb-3" style={{ color: 'var(--color-foreground)' }}>
        最近运行
      </h3>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {runs.length === 0 ? (
          <EmptyState
            icon="activity"
            title="还没有运行"
            description="到用例详情页执行用例,结果会在这里汇总。"
          />
        ) : (
          runs.map((r) => (
            <div
              key={r.id}
              onClick={() =>
                r.kind === 'plan'
                  ? navigate(`/p/${projectId}/plans/${r.caseId}/runs/${r.id}`)
                  : navigate(`/p/${projectId}/reports/${r.id}`)
              }
              className="flex items-center gap-3 py-2 cursor-pointer list-row-clickable hairline-bottom"
            >
              <span
                className="flex-1 truncate text-[13px]"
                style={{ color: 'var(--color-foreground)' }}
              >
                {r.caseTitle || r.caseId.slice(0, 8)}
              </span>
              <StatusPill status={r.status} pulse={r.status === 'running'}>
                {r.status}
              </StatusPill>
              <span
                className="text-[11px] font-mono shrink-0"
                style={{ color: 'var(--color-foreground-muted)' }}
              >
                {new Date(r.createdAt).toLocaleTimeString('zh-CN', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}