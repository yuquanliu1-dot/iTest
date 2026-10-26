import { useTranslation } from 'react-i18next';
import Segmented from '../../../components/ui/Segmented';
import IconButton from '../../../components/ui/IconButton';
import {
  PageShellActions,
  PageShellDescription,
  PageShellHeader,
  PageShellTitle,
} from '../../../components/layout/PageShell';
import type { Range } from '../api';

export interface GreetingSummary {
  name: string;
  days: number;
  runs: number;
  /** 已格式化的百分比文本（如 "86.4"） */
  passRate: string;
  firstPassRate: string;
  healed: number;
}

/**
 * 问候区：「欢迎回来，{name}」+ 摘要行（执行数/双通过率/自愈挽回）。
 * summary 缺省（空项目）时回退静态标题/描述。
 */
export default function OverviewHeader({
  range,
  onRangeChange,
  onRefresh,
  summary,
}: {
  range: Range;
  onRangeChange: (r: Range) => void;
  onRefresh: () => void;
  summary?: GreetingSummary;
}) {
  const { t } = useTranslation();
  return (
    <PageShellHeader>
      {summary ? (
        <PageShellTitle>
          {t('overview:greetingPrefix')}
          <span style={{ color: 'var(--primary)' }}>{summary.name}</span>
        </PageShellTitle>
      ) : (
        <PageShellTitle>{t('overview:title')}</PageShellTitle>
      )}
      <PageShellActions>
        <Segmented<Range>
          options={[
            { value: '7d', label: t('overview:range7d') },
            { value: '30d', label: t('overview:range30d') },
          ]}
          value={range}
          onChange={onRangeChange}
        />
        <IconButton icon="refresh" title={t('overview:refresh')} size="md" onClick={onRefresh} />
      </PageShellActions>
      <PageShellDescription>
        {summary
          ? t('overview:greetingSummary', {
              days: summary.days,
              runs: summary.runs.toLocaleString(),
              pass: summary.passRate,
              first: summary.firstPassRate,
              healed: summary.healed,
            })
          : t('overview:description')}
      </PageShellDescription>
    </PageShellHeader>
  );
}
