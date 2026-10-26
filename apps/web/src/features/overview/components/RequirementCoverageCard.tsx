import { useTranslation } from 'react-i18next';
import { formatPct } from '../format';
import { Panel } from './Panel';
import MeterBar from './MeterBar';
import type { OverviewResponse } from '../api';

type Coverage = OverviewResponse['coverage'];

/** 需求覆盖：用例需求关联率大数 + 进度条 + coverageTypes 分布 chips + 未覆盖脚注。 */
export default function RequirementCoverageCard({ coverage }: { coverage: Coverage }) {
  const { t } = useTranslation();
  const rate = coverage.totalCases === 0 ? 0 : coverage.linkedCases / coverage.totalCases;

  const chips = Object.entries(coverage.byCoverageType)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => ({
      type,
      count,
      label: t(`overview:coverageType_${type}`, { defaultValue: type }),
      pct: coverage.totalCases === 0 ? '0' : formatPct(count / coverage.totalCases),
    }));

  return (
    <Panel
      title={t('overview:coverageTitle')}
      subtitle={t('overview:coverageSub', {
        total: coverage.totalRequirements,
        linked: coverage.linkedRequirements,
      })}
    >
      <div className="flex items-baseline gap-2.5">
        <span
          className="font-semibold tabular-nums leading-none"
          style={{ fontSize: 28, color: 'var(--foreground)' }}
        >
          {formatPct(rate)}%
        </span>
        <span className="text-[12.5px]" style={{ color: 'var(--muted-foreground)' }}>
          {t('overview:coverageRateLabel', {
            linked: coverage.linkedCases.toLocaleString(),
            total: coverage.totalCases.toLocaleString(),
          })}
        </span>
      </div>
      <div className="mt-3">
        <MeterBar pct={rate * 100} color="var(--success)" />
      </div>
      {chips.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <span
              key={c.type}
              className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-medium"
              style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}
            >
              {c.label}
              <b className="tabular-nums" style={{ color: 'var(--foreground)', marginLeft: 4 }}>
                {c.pct}%
              </b>
            </span>
          ))}
        </div>
      )}
      <div
        className="mt-3.5 border-t pt-3 text-[12px]"
        style={{ borderColor: 'var(--border)', color: 'var(--muted-foreground)' }}
      >
        {t('overview:coverageFootUncovered', { count: coverage.uncoveredRequirements })}
      </div>
    </Panel>
  );
}
