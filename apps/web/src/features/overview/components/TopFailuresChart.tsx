import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Panel } from './Panel';
import MeterBar from './MeterBar';
import type { OverviewResponse } from '../api';

type Top = OverviewResponse['topFailures'];

/** Top 失败用例：名称 + 失败占比条 + 次数；flaky 行带「疑似 flaky」软徽标；行点击跳最近报告。 */
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

  // h-full：与同排卡片等高（内容短时空白留在卡内，底部对齐）
  return (
    <Panel className="h-full" title={t('overview:topFailuresTitle')} subtitle={t('overview:topFailuresRange', { days })}>
      {data.length === 0 ? (
        <p className="py-8 text-center text-[12.5px]" style={{ color: 'var(--muted-foreground)' }}>
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
                className="grid cursor-pointer grid-cols-[minmax(0,1fr)_32px] items-center gap-2.5 rounded-[var(--radius-sm)] px-1.5 py-[7px] transition-colors hover:bg-muted/60"
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
                        className="mt-1 block w-fit rounded-full px-1.5 py-px text-[10.5px] font-medium"
                        style={{ background: 'var(--warning-soft)', color: 'var(--warning)' }}
                      >
                        {t('overview:flakyLabel')}
                      </small>
                    )}
                  </span>
                  <MeterBar pct={(d.failureCount / max) * 100} color="var(--chart-1)" size="sm" />
                </div>
                <span
                  className="text-right text-[12.5px] font-semibold tabular-nums"
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
