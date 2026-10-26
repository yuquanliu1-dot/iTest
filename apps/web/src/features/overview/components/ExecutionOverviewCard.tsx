import { useTranslation } from 'react-i18next';
import { formatDuration, formatPct } from '../format';
import { Panel } from './Panel';
import MeterBar from './MeterBar';
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
  pct: number;
  color: string;
  timesText: string;
}) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1.5 flex items-baseline justify-between text-[13px]">
        <span style={{ color: 'var(--muted-foreground)' }}>{label}</span>
        <span className="tabular-nums" style={{ color: 'var(--foreground)', fontWeight: 550 }}>
          {count.toLocaleString()}
          <small style={{ color: 'var(--muted-foreground)', fontWeight: 400, marginLeft: 4 }}>
            {timesText}
          </small>
        </span>
      </div>
      <MeterBar pct={pct} color={color} />
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
  const pctOf = (n: number) => (totalRuns === 0 ? 0 : (n / totalRuns) * 100);

  const meters = [
    { label: t('overview:execPassed'), count: executions.passed, color: 'var(--success)' },
    { label: t('overview:execFailed'), count: executions.failed, color: 'var(--destructive)' },
    { label: t('overview:execBlocked'), count: executions.blocked, color: 'var(--warning)' },
    { label: t('overview:execHealed'), count: executions.healed, color: 'var(--info)' },
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
    <Panel
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
      {attention.length > 0 && (
        <div className="mt-4 rounded-[var(--radius-md)] bg-[var(--muted)] p-3">
          <div className="mb-2 flex items-center gap-2 text-[13px]" style={{ color: 'var(--foreground)' }}>
            <span className="tabular-nums font-semibold" style={{ color: 'var(--primary)' }}>
              {attention.length}
            </span>
            <span>{t('overview:attentionTitle', { count: attention.length })}</span>
          </div>
          {attention.map((item) => (
            <div
              key={item}
              className="flex items-baseline gap-2 py-[5px] text-[12.5px]"
              style={{ color: 'var(--muted-foreground)' }}
            >
              <i className="mt-[7px] size-1.5 shrink-0 rounded-full bg-[var(--primary)]" aria-hidden />
              <span className="min-w-0">{item}</span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
