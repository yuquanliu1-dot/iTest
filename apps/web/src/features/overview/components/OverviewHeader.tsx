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

/**
 * 页头：标题只交代页面语境（不做人名问候，数字都在下面的卡片里），
 * 时间范围由 Segmented 控件显式表达。
 */
export default function OverviewHeader({
  range,
  onRangeChange,
  onRefresh,
}: {
  range: Range;
  onRangeChange: (r: Range) => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  return (
    <PageShellHeader>
      <PageShellTitle>{t('overview:title')}</PageShellTitle>
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
      <PageShellDescription>{t('overview:description')}</PageShellDescription>
    </PageShellHeader>
  );
}
