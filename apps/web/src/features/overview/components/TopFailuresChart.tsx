import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Panel } from './Panel';
import MeterBar from './MeterBar';
import type { OverviewResponse } from '../api';

type Top = OverviewResponse['topFailures'];

/**
 * Top failing cases: name + failure-share bar (red = verdict) + count + evidence anchor.
 * The evidence anchor (# + first 4 chars of the report id, monospace) is the page's only signature detail: every failure links back to that run.
 */
export default function TopFailuresChart({
  data,
  days,
  latestReportByCase,
  projectId,
}: {
  data: Top;
  days: number;
  latestReportByCase: Map<string, string>;
  projectId: string;
}) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { versionId } = useParams<{ versionId: string }>();
  const max = Math.max(...data.map((d) => d.failureCount), 1);

  return (
    <Panel
      className="h-full"
      title={t('overview:topFailuresTitle')}
      subtitle={t('overview:topFailuresRange', { days })}
    >
      {data.length === 0 ? (
        <p className="py-8 text-center text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
          {t('overview:topFailuresEmpty', { days })}
        </p>
      ) : (
        <div className="flex flex-col">
          {data.map((d) => {
            const reportId = latestReportByCase.get(d.caseId);
            return (
              <div
                key={d.caseId}
                onClick={() => {
                  if (reportId) navigate(`/p/${projectId}/v/${versionId}/reports/${reportId}`);
                }}
                className="grid cursor-pointer grid-cols-[minmax(0,1fr)_minmax(0,88px)_44px_28px] items-center gap-2 rounded-[var(--radius-sm)] px-2 py-2 transition-colors hover:bg-muted/60"
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && reportId) {
                    navigate(`/p/${projectId}/v/${versionId}/reports/${reportId}`);
                  }
                }}
              >
                <span
                  className="truncate text-[12px] leading-tight"
                  style={{ color: 'var(--muted-foreground)' }}
                  title={d.caseTitle}
                >
                  {d.caseTitle}
                  {d.flakySuspected && (
                    <small
                      className="mt-1 block w-fit rounded-full px-1.5 py-px text-[11px] font-medium"
                      style={{ background: 'var(--warning-soft)', color: 'var(--warning)' }}
                    >
                      {t('overview:flakyLabel')}
                    </small>
                  )}
                </span>
                <MeterBar pct={(d.failureCount / max) * 100} color="var(--destructive)" size="sm" />
                <span
                  className="truncate font-mono text-[11px] tracking-wide"
                  style={{ color: reportId ? 'var(--muted-foreground)' : 'transparent' }}
                  title={reportId}
                >
                  {reportId ? `#${reportId.slice(0, 4)}` : '·'}
                </span>
                <span
                  className="text-right text-[12px] font-semibold tabular-nums"
                  style={{ color: 'var(--foreground)' }}
                >
                  {d.failureCount}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
