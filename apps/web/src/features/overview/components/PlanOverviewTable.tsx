import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { CSSProperties } from 'react';
import StatusPill from '../../../components/ui/StatusPill';
import { formatPct } from '../format';
import type { OverviewResponse } from '../api';

type Plan = OverviewResponse['plans'][number];

const RCA_COLOR: Record<string, string> = {
  case_issue: 'var(--chart-1)',
  environment: 'var(--chart-3)',
  system_defect: 'var(--destructive)',
  other: 'var(--muted-foreground)',
};

const RCA_LABEL: Record<string, string> = {
  case_issue: 'overview:rcaCaseIssue',
  environment: 'overview:rcaEnvironment',
  system_defect: 'overview:rcaSystemDefect',
  other: 'overview:rcaOther',
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 计划概览表：状态徽标 + 通过率刻度条 + 最近 RCA 徽标 + 触发方式。行点击进计划详情。 */
export default function PlanOverviewTable({
  plans,
  schedulesCount,
  projectId,
}: {
  plans: Plan[];
  schedulesCount: number;
  projectId: string;
}) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { versionId } = useParams<{ versionId: string }>();

  return (
    <div className="bg-card border border-[var(--border)] rounded-[var(--radius-md)] p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-[14px] font-semibold" style={{ color: 'var(--foreground)' }}>
          {t('overview:planTableTitle')}
        </h3>
        <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
          {t('overview:planTableSub', { count: plans.length })}
          {schedulesCount > 0 && (
            <span style={{ color: 'var(--primary)', marginLeft: 8 }}>
              {t('overview:planTableSchedules', { count: schedulesCount })}
            </span>
          )}
        </span>
      </div>
      {plans.length === 0 ? (
        <p className="py-6 text-center text-[12.5px]" style={{ color: 'var(--muted-foreground)' }}>
          {t('overview:planEmpty')}
        </p>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {['planColName', 'planColStatus', 'planColPassRate', 'planColCases', 'planColLastRun', 'planColRca', 'planColTrigger'].map(
                (key) => (
                  <th
                    key={key}
                    className="border-b px-3 pb-2 text-left text-[12px] font-medium"
                    style={{ borderColor: 'var(--border)', color: 'var(--muted-foreground)' }}
                  >
                    {t(`overview:${key}`)}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => (
              <tr
                key={p.id}
                onClick={() => navigate(`/p/${projectId}/v/${versionId}/plans/${p.id}`)}
                className="cursor-pointer transition-colors hover:bg-[var(--muted)]"
              >
                <td className="max-w-[220px] truncate px-3 py-3 text-[13px] font-medium" style={{ color: 'var(--foreground)' }}>
                  {p.name}
                </td>
                <td className="px-3 py-3">
                  {p.lastStatus ? (
                    <StatusPill status={p.lastStatus} pulse={p.lastStatus === 'running'}>
                      {t(`cases:status.${p.lastStatus}`, { defaultValue: p.lastStatus })}
                    </StatusPill>
                  ) : (
                    <StatusPill tone="muted">{t('overview:planNotRun')}</StatusPill>
                  )}
                </td>
                <td className="px-3 py-3">
                  {p.lastRunAt ? (
                    <span className="flex items-center gap-2.5">
                      <span className="inline-block h-3 w-24 overflow-hidden rounded bg-[var(--muted)]">
                        <span
                          className="meter-ticks block h-full rounded"
                          style={{ '--fill': 'var(--chart-1)', width: `${formatPct(p.passRate)}%` } as CSSProperties}
                        />
                      </span>
                      <span className="text-[12.5px] font-semibold" style={{ color: 'var(--foreground)' }}>
                        {formatPct(p.passRate)}%
                      </span>
                    </span>
                  ) : (
                    <span className="text-[12.5px]" style={{ color: 'var(--muted-foreground)' }}>—</span>
                  )}
                </td>
                <td className="px-3 py-3 text-[13px]" style={{ color: 'var(--foreground)' }}>
                  {p.totalCases}
                </td>
                <td className="px-3 py-3 font-mono text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
                  {p.lastRunAt ? fmtTime(p.lastRunAt) : '—'}
                </td>
                <td className="px-3 py-3">
                  {p.lastRcaCategory ? (
                    <span
                      className="inline-flex rounded-md px-2 py-0.5 text-[11.5px] font-medium"
                      style={{
                        color: RCA_COLOR[p.lastRcaCategory] ?? 'var(--muted-foreground)',
                        background: `color-mix(in oklch, ${RCA_COLOR[p.lastRcaCategory] ?? 'var(--muted-foreground)'} 13%, transparent)`,
                      }}
                    >
                      {t(RCA_LABEL[p.lastRcaCategory] ?? 'overview:rcaOther')}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--muted-foreground)' }}>—</span>
                  )}
                </td>
                <td className="px-3 py-3">
                  {p.triggeredBy ? (
                    <span
                      className="inline-flex rounded-md border border-[var(--border)] bg-[var(--muted)] px-2 py-0.5 text-[12px]"
                      style={{ color: 'var(--muted-foreground)' }}
                    >
                      {t(p.triggeredBy === 'schedule' ? 'overview:triggerSchedule' : 'overview:triggerManual')}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--muted-foreground)' }}>—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
