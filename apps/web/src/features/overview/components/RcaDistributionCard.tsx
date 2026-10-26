import { useTranslation } from 'react-i18next';
import type { OverviewResponse } from '../api';

type Rca = OverviewResponse['rca'];

const CATEGORY_META: Array<{
  key: 'case_issue' | 'environment' | 'system_defect' | 'other';
  labelKey: string;
  color: string;
}> = [
  { key: 'case_issue', labelKey: 'overview:rcaCaseIssue', color: 'var(--chart-1)' },
  { key: 'environment', labelKey: 'overview:rcaEnvironment', color: 'var(--chart-3)' },
  { key: 'system_defect', labelKey: 'overview:rcaSystemDefect', color: 'var(--destructive)' },
  { key: 'other', labelKey: 'overview:rcaOther', color: 'var(--muted-foreground)' },
];

/** RCA 根因分布：4 类横条 + 高置信度脚注。无分析结果时展示空态。 */
export default function RcaDistributionCard({ days, rca }: { days: number; rca: Rca }) {
  const { t } = useTranslation();
  const max = Math.max(...CATEGORY_META.map((m) => rca.byCategory[m.key]), 1);

  return (
    <div className="bg-card border border-[var(--border)] rounded-[var(--radius-md)] p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-[14px] font-semibold" style={{ color: 'var(--foreground)' }}>
          {t('overview:rcaTitle')}
        </h3>
        <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
          {t('overview:rcaSub', { days, count: rca.analyzed })}
        </span>
      </div>
      {rca.analyzed === 0 ? (
        <p className="py-8 text-center text-[12.5px]" style={{ color: 'var(--muted-foreground)' }}>
          {t('overview:rcaEmpty')}
        </p>
      ) : (
        <>
          {CATEGORY_META.map((m) => {
            const count = rca.byCategory[m.key];
            return (
              <div key={m.key} className="grid grid-cols-[minmax(0,1fr)_32px] items-center gap-2.5 py-[7px]">
                <div className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2.5">
                  <span className="truncate text-[12.5px]" style={{ color: 'var(--muted-foreground)' }}>
                    {t(m.labelKey)}
                  </span>
                  <div className="h-[13px] overflow-hidden rounded bg-[var(--muted)]">
                    <div
                      className="h-full rounded"
                      style={{
                        width: `${(count / max) * 100}%`,
                        background: m.color,
                      }}
                    />
                  </div>
                </div>
                <span className="text-right text-[12.5px] font-semibold" style={{ color: 'var(--foreground)' }}>
                  {count}
                </span>
              </div>
            );
          })}
          <div
            className="mt-3.5 border-t pt-3 text-[12px]"
            style={{ borderColor: 'var(--border)', color: 'var(--muted-foreground)' }}
          >
            {t('overview:rcaFootConfidence', { high: rca.highConfidence, total: rca.analyzed })}
          </div>
        </>
      )}
    </div>
  );
}
