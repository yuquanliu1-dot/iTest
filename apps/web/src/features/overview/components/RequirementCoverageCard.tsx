import { useTranslation } from 'react-i18next';
import { COVERAGE_TYPE_KEYS } from '@itest/shared';
import { formatPct } from '../format';
import { Panel } from './Panel';
import MeterBar from './MeterBar';
import type { OverviewResponse } from '../api';

type Coverage = OverviewResponse['coverage'];

/**
 * 需求覆盖：需求被用例覆盖的比例（大数 + 进度条）+ 用例覆盖类型分布。
 * 分布列出全部已知类型（含计数为 0 的），因为「一个类型都没声明」本身就是信号。
 */
export default function RequirementCoverageCard({ coverage }: { coverage: Coverage }) {
  const { t } = useTranslation();
  const rate = coverage.totalRequirements === 0 ? 0 : coverage.linkedRequirements / coverage.totalRequirements;
  const maxType = Math.max(...COVERAGE_TYPE_KEYS.map((k) => coverage.byCoverageType[k] ?? 0), 1);

  return (
    <Panel
      className="h-full"
      title={t('overview:coverageTitle')}
      subtitle={t('overview:coverageSub', {
        total: coverage.totalRequirements,
        linked: coverage.linkedRequirements,
      })}
    >
      <div className="flex items-baseline gap-2">
        <span
          className="font-semibold tabular-nums leading-none"
          style={{ fontSize: 28, color: 'var(--foreground)' }}
        >
          {formatPct(rate)}%
        </span>
        <span className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
          {t('overview:coverageRateLabel')}
        </span>
      </div>
      <div className="mt-3">
        <MeterBar pct={rate * 100} color="var(--muted-foreground)" />
      </div>

      <div className="mt-4 border-t pt-3">
        <div className="mb-2 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
          {t('overview:coverageTypeTitle')}
        </div>
        <div className="flex flex-col gap-2">
          {COVERAGE_TYPE_KEYS.map((type) => {
            const count = coverage.byCoverageType[type] ?? 0;
            return (
              <div key={type} className="grid grid-cols-[72px_minmax(0,1fr)_32px] items-center gap-2">
                <span className="truncate text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
                  {t(`overview:coverageType_${type}`, { defaultValue: type })}
                </span>
                <MeterBar pct={(count / maxType) * 100} color="var(--muted-foreground)" size="sm" />
                <span
                  className="text-right text-[12px] font-semibold tabular-nums"
                  style={{ color: count > 0 ? 'var(--foreground)' : 'var(--muted-foreground)' }}
                >
                  {count}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </Panel>
  );
}
