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
