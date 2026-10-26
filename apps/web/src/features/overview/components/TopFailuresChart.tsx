import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { OverviewResponse } from '../api';

type Top = OverviewResponse['topFailures'];

/** Top 失败用例：名称 + 橙色横条 + 次数；flaky 行带「疑似 flaky」副注；行点击跳最近报告。 */
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
    <div className="bg-card border border-[var(--border)] rounded-[var(--radius-md)] p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-[14px] font-semibold" style={{ color: 'var(--foreground)' }}>
          {t('overview:topFailuresTitle')}
        </h3>
        <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
          {t('overview:topFailuresRange', { days })}
        </span>
      </div>
      {data.length === 0 ? (
        <p className="py-8 text-center text-[12.5px]" style={{ color: 'var(--muted-foreground)' }}>
          {t('overview:topFailuresEmpty', { days })}
        </p>
      ) : (
        data.map((d) => {
          const reportId = latestReportByCase.get(d.caseId);
          return (
            <div
              key={d.caseId}
              onClick={() => {
                if (reportId) navigate(`/p/${projectId}/v/${versionId}/reports/${reportId}`);
              }}
              className="grid cursor-pointer grid-cols-[minmax(0,1fr)_32px] items-center gap-2.5 rounded-md py-[7px] transition-colors hover:bg-[var(--muted)]"
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && reportId) {
                  navigate(`/p/${projectId}/v/${versionId}/reports/${reportId}`);
                }
              }}
            >
              <div className="grid grid-cols-[minmax(0,140px)_minmax(0,1fr)] items-center gap-2.5">
                <span
                  className="truncate text-[12.5px] leading-tight"
                  style={{ color: 'var(--muted-foreground)' }}
                  title={d.caseTitle}
                >
                  {d.caseTitle}
                  {d.flakySuspected && (
                    <small
                      className="block text-[10.5px]"
                      style={{ color: 'var(--chart-4)', marginTop: 1 }}
                    >
                      {t('overview:flakyLabel')}
                    </small>
                  )}
                </span>
                <div className="h-[13px] overflow-hidden rounded bg-[var(--muted)]">
                  <div
                    className="h-full rounded"
                    style={{
                      width: `${(d.failureCount / max) * 100}%`,
                      background: 'linear-gradient(90deg, var(--chart-5), var(--chart-1))',
                    }}
                  />
                </div>
              </div>
              <span
                className="text-right text-[12.5px] font-semibold"
                style={{ color: 'var(--foreground)' }}
              >
                {d.failureCount}
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}
