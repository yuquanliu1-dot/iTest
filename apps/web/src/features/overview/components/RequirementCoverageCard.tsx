import { useTranslation } from 'react-i18next';
import { formatPct } from '../format';
import type { OverviewResponse } from '../api';

type Coverage = OverviewResponse['coverage'];

/** 需求覆盖：用例需求关联率大数 + 刻度条 + coverageTypes 分布 chips + 未覆盖脚注。 */
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
    <div className="bg-card border border-[var(--border)] rounded-[var(--radius-md)] p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-[14px] font-semibold" style={{ color: 'var(--foreground)' }}>
          {t('overview:coverageTitle')}
        </h3>
        <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
          {t('overview:coverageSub', {
            total: coverage.totalRequirements,
            linked: coverage.linkedRequirements,
          })}
        </span>
      </div>
      <div className="flex items-baseline gap-2.5">
        <span className="text-[32px] font-bold leading-none" style={{ color: 'var(--foreground)' }}>
          {formatPct(rate)}%
        </span>
        <span className="text-[12.5px]" style={{ color: 'var(--muted-foreground)' }}>
          {t('overview:coverageRateLabel', {
            linked: coverage.linkedCases.toLocaleString(),
            total: coverage.totalCases.toLocaleString(),
          })}
        </span>
      </div>
      <div className="mb-4 mt-2.5 h-[14px] overflow-hidden rounded bg-[var(--muted)]">
        <div
          className="meter-ticks h-full rounded"
          style={{ '--fill': 'var(--success)', width: `${formatPct(rate)}%` } as React.CSSProperties}
        />
      </div>
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {chips.map((c) => (
            <span
              key={c.type}
              className="rounded-[7px] border border-[var(--border)] bg-[var(--muted)] px-2.5 py-1 text-[12px]"
              style={{ color: 'var(--muted-foreground)' }}
            >
              {c.label}
              <b style={{ color: 'var(--foreground)', fontWeight: 600, marginLeft: 4 }}>{c.pct}%</b>
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
    </div>
  );
}
