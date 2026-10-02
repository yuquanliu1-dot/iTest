import Segmented from '../../../components/ui/Segmented';
import IconButton from '../../../components/ui/IconButton';
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
    <div className="flex items-center justify-between px-5 pt-4">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight" style={{ color: 'var(--color-foreground)' }}>
          总览
        </h1>
        <p className="text-[13px] mt-0.5" style={{ color: 'var(--color-foreground-muted)' }}>
          用例 → 执行 → 计划 全链路概览
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Segmented<Range>
          options={[
            { value: '7d', label: '7 天' },
            { value: '30d', label: '30 天' },
          ]}
          value={range}
          onChange={onRangeChange}
        />
        <IconButton icon="refresh" title="刷新" size="md" onClick={onRefresh} />
      </div>
    </div>
  );
}
