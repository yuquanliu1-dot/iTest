import { useTranslation } from 'react-i18next';
import { Panel } from './Panel';
import MeterBar from './MeterBar';
import { RCA_CATEGORY_COLOR } from '../chartTheme';
import type { OverviewResponse } from '../api';

type Rca = OverviewResponse['rca'];

/**
 * RCA root-cause distribution: 4 horizontal category bars + a high-confidence footnote. Shows the empty state when no analysis results exist.
 * Colors come from the shared RCA category table (same source as the main RCA badge RcaBlock.tsx):
 * system defect red / environment yellow / case issue and other gray. Zero-count categories draw no empty bar.
 */
const CATEGORY_META: Array<{
  key: 'case_issue' | 'environment' | 'system_defect' | 'other';
  labelKey: string;
}> = [
  { key: 'system_defect', labelKey: 'overview:rcaSystemDefect' },
  { key: 'environment', labelKey: 'overview:rcaEnvironment' },
  { key: 'case_issue', labelKey: 'overview:rcaCaseIssue' },
  { key: 'other', labelKey: 'overview:rcaOther' },
];

export default function RcaDistributionCard({ days, rca }: { days: number; rca: Rca }) {
  const { t } = useTranslation();
  const max = Math.max(...CATEGORY_META.map((m) => rca.byCategory[m.key]), 1);

  return (
    <Panel
      className="h-full"
      title={t('overview:rcaTitle')}
      subtitle={t('overview:rcaSub', { days, count: rca.analyzed })}
    >
      {rca.analyzed === 0 ? (
        <p className="py-8 text-center text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
          {t('overview:rcaEmpty')}
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            {CATEGORY_META.map((m) => {
              const count = rca.byCategory[m.key];
              return (
                <div key={m.key} className="grid grid-cols-[minmax(0,1fr)_32px] items-center gap-2">
                  <div className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2">
                    <span className="truncate text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
                      {t(m.labelKey)}
                    </span>
                    <MeterBar pct={(count / max) * 100} color={RCA_CATEGORY_COLOR[m.key]!} size="sm" />
                  </div>
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
          <div
            className="mt-4 border-t pt-3 text-[12px]"
            style={{ borderColor: 'var(--border)', color: 'var(--muted-foreground)' }}
          >
            {t('overview:rcaFootConfidence', { high: rca.highConfidence, total: rca.analyzed })}
          </div>
        </>
      )}
    </Panel>
  );
}
