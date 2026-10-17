import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import StatusPill from '../../../components/ui/StatusPill';
import EmptyState from '../../../components/ui/EmptyState';
import type { OverviewResponse } from '../api';

type Run = OverviewResponse['recentRuns'][number];

export default function RecentRunsStream({ runs, projectId }: { runs: Run[]; projectId: string }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { versionId } = useParams<{ versionId: string }>();

  return (
    <div
      className="bg-card border border-[var(--border)] rounded-[var(--radius-md)] p-5 flex flex-col"
    >
      <h3 className="text-[14px] font-semibold mb-3" style={{ color: 'var(--foreground)' }}>
        {t('overview:recentRunsTitle')}
      </h3>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {runs.length === 0 ? (
          <EmptyState
            icon="activity"
            title={t('overview:recentRunsEmptyTitle')}
            description={t('overview:recentRunsEmptyDescription')}
          />
        ) : (
          runs.map((r) => (
            <div
              key={r.id}
              onClick={() =>
                r.kind === 'plan'
                  ? navigate(`/p/${projectId}/v/${versionId}/plans/${r.caseId}/runs/${r.id}`)
                  : navigate(`/p/${projectId}/v/${versionId}/reports/${r.id}`)
              }
              className="flex items-center gap-3 py-2 cursor-pointer list-row-clickable hairline-bottom"
            >
              <span
                className="flex-1 truncate text-[13px]"
                style={{ color: 'var(--foreground)' }}
              >
                {r.caseTitle || r.caseId.slice(0, 8)}
              </span>
              <StatusPill status={r.status} pulse={r.status === 'running'}>
                {t(`cases:status.${r.status}`, { defaultValue: r.status })}
              </StatusPill>
              <span
                className="text-[11px] font-mono shrink-0"
                style={{ color: 'var(--muted-foreground)' }}
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