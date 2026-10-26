import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDuration, formatPct } from '../format';
import type { OverviewResponse } from '../api';

type Executions = OverviewResponse['executions'];
type TopFailures = OverviewResponse['topFailures'];
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
  pct: string;
  color: string;
  timesText: string;
}) {
  return (
    <div className="mb-3.5 last:mb-0">
      <div className="mb-1.5 flex items-center justify-between text-[13px]">
        <span style={{ color: 'var(--muted-foreground)' }}>{label}</span>
        <span style={{ color: 'var(--foreground)', fontWeight: 550 }}>
          {count.toLocaleString()}
          <small style={{ color: 'var(--muted-foreground)', fontWeight: 400, marginLeft: 4 }}>
            {timesText}
          </small>
        </span>
      </div>
      <div className="h-[14px] overflow-hidden rounded bg-[var(--muted)]">
        <div
          className="meter-ticks h-full rounded"
          style={{ '--fill': color, width: `${pct}%` } as CSSProperties}
        />
      </div>
    </div>
  );
}

/** 执行概览：成功/失败/阻塞/AI 自愈挽回 meters +「需要关注」派生列表（无数据项隐藏）。 */
export default function ExecutionOverviewCard({
  days,
  executions,
  totalRuns,
  p95DurationMs,
  solidifyPendingSteps,
  solidifyPendingAiTasks,
  topFailures,
  rca,
}: {
  days: number;
  executions: Executions;
  totalRuns: number;
  p95DurationMs: number | null;
  solidifyPendingSteps: number;
  solidifyPendingAiTasks: number;
  topFailures: TopFailures;
  rca: Rca;
}) {
  const { t } = useTranslation();
  const pctOf = (n: number) => (totalRuns === 0 ? '0' : formatPct(n / totalRuns));

  const meters = [
    { label: t('overview:execPassed'), count: executions.passed, color: 'var(--success)' },
    { label: t('overview:execFailed'), count: executions.failed, color: 'var(--destructive)' },
    { label: t('overview:execBlocked'), count: executions.blocked, color: 'var(--primary)' },
    { label: t('overview:execHealed'), count: executions.healed, color: 'var(--chart-4)' },
  ];

  // 需要关注：Top 失败 / flaky（与 Top 失败去重）/ RCA 环境占比 / 待固化步数
  const attention: string[] = [];
  if (topFailures[0]) {
    attention.push(
      t('overview:attentionTopFail', {
        name: topFailures[0].caseTitle,
        count: topFailures[0].failureCount,
      }),
    );
  }
  const flaky = topFailures.find((f) => f.flakySuspected && f.caseId !== topFailures[0]?.caseId);
  if (flaky) {
    attention.push(
      t('overview:attentionFlaky', {
        name: flaky.caseTitle,
        runs: flaky.totalRuns,
        fails: flaky.failureCount,
      }),
    );
  }
  if (rca.analyzed > 0 && rca.byCategory.environment / rca.analyzed >= 0.2) {
    attention.push(t('overview:attentionRcaEnv', { value: formatPct(rca.byCategory.environment / rca.analyzed) }));
  }
  if (solidifyPendingSteps > 0) {
    attention.push(
      t('overview:attentionSolidify', { count: solidifyPendingSteps, ai: solidifyPendingAiTasks }),
    );
  }

  return (
    <div className="bg-card border border-[var(--border)] rounded-[var(--radius-md)] p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-[14px] font-semibold" style={{ color: 'var(--foreground)' }}>
          {t('overview:execOverviewTitle')}
        </h3>
        <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
          {t('overview:execOverviewSub', {
            days,
            runs: totalRuns.toLocaleString(),
            p95: formatDuration(p95DurationMs),
          })}
        </span>
      </div>
      {meters.map((m) => (
        <Meter
          key={m.label}
          label={m.label}
          count={m.count}
          pct={pctOf(m.count)}
          color={m.color}
          timesText={t('overview:execMeterSuffix', { pct: pctOf(m.count) })}
        />
      ))}
      {attention.length > 0 && (
        <div className="mt-4 rounded-[10px] border border-[var(--border)] p-3.5">
          <div className="mb-2.5 flex items-center gap-2 text-[13px]" style={{ color: 'var(--foreground)' }}>
            <span style={{ color: 'var(--primary)', fontWeight: 600 }}>{attention.length}</span>
            <span>{t('overview:attentionTitle', { count: attention.length })}</span>
          </div>
          {attention.map((item) => (
            <div
              key={item}
              className="flex items-baseline gap-2 py-[5px] text-[12.5px]"
              style={{ color: 'var(--muted-foreground)' }}
            >
              <i className="mt-[7px] h-1.5 w-1.5 shrink-0 bg-[var(--primary)]" aria-hidden />
              <span className="min-w-0">{item}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
