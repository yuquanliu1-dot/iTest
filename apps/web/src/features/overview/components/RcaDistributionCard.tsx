import { useTranslation } from 'react-i18next';
import { Panel } from './Panel';
import MeterBar from './MeterBar';
import type { OverviewResponse } from '../api';

type Rca = OverviewResponse['rca'];

/**
 * RCA 根因分布：4 类横条 + 高置信度脚注。无分析结果时展示空态。
 * 配色与主体 RCA 徽章一致（RcaBlock.tsx）：系统缺陷红 / 环境黄 / 用例问题与其他灰。
 */
const CATEGORY_META: Array<{
  key: 'case_issue' | 'environment' | 'system_defect' | 'other';
  labelKey: string;
  color: string;
}> = [
  { key: 'system_defect', labelKey: 'overview:rcaSystemDefect', color: 'var(--destructive)' },
  { key: 'environment', labelKey: 'overview:rcaEnvironment', color: 'var(--warning)' },
  { key: 'case_issue', labelKey: 'overview:rcaCaseIssue', color: 'var(--muted-foreground)' },
  { key: 'other', labelKey: 'overview:rcaOther', color: 'var(--border)' },
];

export default function RcaDistributionCard({ days, rca }: { days: number; rca: Rca }) {
  const { t } = useTranslation();
  const max = Math.max(...CATEGORY_META.map((m) => rca.byCategory[m.key]), 1);

  // h-full：与同排卡片等高（内容短时空白留在卡内，底部对齐）
  return (
    <Panel className="h-full" title={t('overview:rcaTitle')} subtitle={t('overview:rcaSub', { days, count: rca.analyzed })}>
      {rca.analyzed === 0 ? (
        <p className="py-8 text-center text-[12.5px]" style={{ color: 'var(--muted-foreground)' }}>
          {t('overview:rcaEmpty')}
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-2.5">
            {CATEGORY_META.map((m) => {
              const count = rca.byCategory[m.key];
              return (
                <div key={m.key} className="grid grid-cols-[minmax(0,1fr)_32px] items-center gap-2.5">
                  <div className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2.5">
                    <span className="truncate text-[12.5px]" style={{ color: 'var(--muted-foreground)' }}>
                      {t(m.labelKey)}
                    </span>
                    <MeterBar pct={(count / max) * 100} color={m.color} size="sm" />
                  </div>
                  <span
                    className="text-right text-[12.5px] font-semibold tabular-nums"
                    style={{ color: 'var(--foreground)' }}
                  >
                    {count}
                  </span>
                </div>
              );
            })}
          </div>
          <div
            className="mt-3.5 border-t pt-3 text-[12px]"
            style={{ borderColor: 'var(--border)', color: 'var(--muted-foreground)' }}
          >
            {t('overview:rcaFootConfidence', { high: rca.highConfidence, total: rca.analyzed })}
          </div>
        </>
      )}
    </Panel>
  );
}
