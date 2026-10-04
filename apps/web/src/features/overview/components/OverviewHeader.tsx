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
  return (
    <PageShellHeader>
      <PageShellTitle>总览</PageShellTitle>
      <PageShellActions>
        <Segmented<Range>
          options={[
            { value: '7d', label: '7 天' },
            { value: '30d', label: '30 天' },
          ]}
          value={range}
          onChange={onRangeChange}
        />
        <IconButton icon="refresh" title="刷新" size="md" onClick={onRefresh} />
      </PageShellActions>
      <PageShellDescription>用例 → 执行 → 计划 全链路概览</PageShellDescription>
    </PageShellHeader>
  );
}
