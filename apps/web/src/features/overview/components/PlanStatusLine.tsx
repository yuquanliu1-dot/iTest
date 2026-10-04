import { useNavigate, useParams } from 'react-router-dom';
import StatusPill from '../../../components/ui/StatusPill';
import type { OverviewResponse } from '../api';

type Plan = OverviewResponse['plans'][number];

export default function PlanStatusLine({ plans, projectId }: { plans: Plan[]; projectId: string }) {
  const navigate = useNavigate();
  const { versionId } = useParams<{ versionId: string }>();

  if (plans.length === 0) {
    return (
      <div className="bg-card border border-[var(--border)] rounded-[var(--radius-md)] p-5">
        <h3 className="text-[14px] font-semibold mb-3" style={{ color: 'var(--foreground)' }}>
          计划列表
        </h3>
        <p className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
          暂无计划
        </p>
      </div>
    );
  }

  return (
    <div
      className="bg-card border border-[var(--border)] rounded-[var(--radius-md)] p-5 flex flex-col"
    >
      <h3 className="text-[14px] font-semibold mb-3" style={{ color: 'var(--foreground)' }}>
        计划运行状态
      </h3>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {plans.map((p) => (
          <div
            key={p.id}
            onClick={() => navigate(`/p/${projectId}/v/${versionId}/plans/${p.id}`)}
            className="flex items-center gap-3 py-2 cursor-pointer list-row-clickable hairline-bottom"
          >
            <span
              className="flex-1 truncate text-[13px]"
              style={{ color: 'var(--foreground)' }}
            >
              {p.name}
            </span>
            {p.lastStatus ? (
              <StatusPill status={p.lastStatus} pulse={p.lastStatus === 'running'}>
                {p.lastStatus}
              </StatusPill>
            ) : (
              <StatusPill tone="muted">未运行</StatusPill>
            )}
            <span
              className="text-[11px] font-mono"
              style={{ color: 'var(--muted-foreground)' }}
            >
              {Math.round(p.passRate * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}