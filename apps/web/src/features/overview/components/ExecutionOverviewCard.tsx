import { useTranslation } from 'react-i18next';
import { formatDuration, formatPct } from '../format';
import { Panel } from './Panel';
import MeterBar from './MeterBar';
import type { OverviewResponse } from '../api';

type Executions = OverviewResponse['executions'];
type Rca = OverviewResponse['rca'];

function Meter({
  label,
  count,
  pct,
  color,
  timesText,
}: {
  label: string;
  count: number;
  pct: number;
  color: string;
  timesText: string;
}) {
  return (
    <div className="mb-4 last:mb-0">
      <div className="mb-2 flex items-baseline justify-between text-[13px]">
        <span style={{ color: 'var(--muted-foreground)' }}>{label}</span>
        <span className="tabular-nums" style={{ color: 'var(--foreground)', fontWeight: 600 }}>
          {count.toLocaleString()}
          <small style={{ color: 'var(--muted-foreground)', fontWeight: 400, marginLeft: 4, fontSize: 12 }}>
            {timesText}
          </small>
        </span>
      </div>
      <MeterBar pct={pct} color={color} />
    </div>
  );
}

/**
 * Execution overview: execution outcomes split three ways (passed / failed / other) + a side note for plan-skipped + a "needs attention" list.
 *
 * The three meters all belong to the single "case report" population; their shares sum to 100%;
 * blocked (cases skipped while a plan run was active) come from a different population, so only the count is shown, no share.
 */
export default function ExecutionOverviewCard({
  days,
  executions,
  totalRuns,
  p95DurationMs,
  solidifyPendingSteps,
  solidifyPendingAiTasks,
  rca,
}: {
  days: number;
  executions: Executions;
  totalRuns: number;
  p95DurationMs: number | null;
  solidifyPendingSteps: number;
  solidifyPendingAiTasks: number;
  rca: Rca;
}) {
  const { t } = useTranslation();
  const pctOf = (n: number) => (totalRuns === 0 ? 0 : (n / totalRuns) * 100);
  const other = Math.max(0, totalRuns - executions.passed - executions.failed);

  const meters = [
    { label: t('overview:execPassed'), count: executions.passed, color: 'var(--success)' },
    { label: t('overview:execFailed'), count: executions.failed, color: 'var(--destructive)' },
    { label: t('overview:execOther'), count: other, color: 'var(--muted-foreground)' },
  ];

  // Needs attention: RCA environment share over the line / pending-solidify steps. Top failures and flaky are already listed in adjacent panels; not repeated here.
  const attention: string[] = [];
  if (rca.analyzed > 0 && rca.byCategory.environment / rca.analyzed >= 0.2) {
    attention.push(t('overview:attentionRcaEnv', { value: formatPct(rca.byCategory.environment / rca.analyzed) }));
  }
  if (solidifyPendingSteps > 0) {
    attention.push(
      t('overview:attentionSolidify', { count: solidifyPendingSteps, ai: solidifyPendingAiTasks }),
    );
  }

  return (
    <Panel
      className="flex h-full flex-col"
      bodyClassName="flex flex-1 flex-col"
      title={t('overview:execOverviewTitle')}
      subtitle={t('overview:execOverviewSub', {
        days,
        runs: totalRuns.toLocaleString(),
        p95: formatDuration(p95DurationMs),
      })}
    >
      {meters.map((m) => (
        <Meter
          key={m.label}
          label={m.label}
          count={m.count}
          pct={pctOf(m.count)}
          color={m.color}
          timesText={t('overview:execMeterSuffix', { pct: formatPct(pctOf(m.count) / 100) })}
        />
      ))}

      {executions.blocked > 0 && (
        <div
          className="mt-1 flex items-baseline justify-between border-t pt-3 text-[13px]"
          style={{ borderColor: 'var(--border)', color: 'var(--muted-foreground)' }}
        >
          <span>{t('overview:execBlockedSkipped')}</span>
          <span className="tabular-nums" style={{ color: 'var(--foreground)' }}>
            {executions.blocked.toLocaleString()}
          </span>
        </div>
      )}

      {attention.length > 0 && (
        <div className="mt-auto pt-4">
          <div className="rounded-[var(--radius-sm)] bg-[var(--muted)] p-3">
            <div className="mb-2 flex items-center gap-2 text-[13px]" style={{ color: 'var(--foreground)' }}>
              <span className="tabular-nums font-semibold" style={{ color: 'var(--primary)' }}>
                {attention.length}
              </span>
              <span>{t('overview:attentionTitle')}</span>
            </div>
            {attention.map((item) => (
              <div
                key={item}
                className="flex items-baseline gap-2 py-1 text-[12px]"
                style={{ color: 'var(--muted-foreground)' }}
              >
                <i className="mt-[6px] size-1.5 shrink-0 rounded-full bg-[var(--primary)]" aria-hidden />
                <span className="min-w-0">{item}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
