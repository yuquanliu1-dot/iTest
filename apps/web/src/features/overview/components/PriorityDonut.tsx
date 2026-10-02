import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { chartColors, tooltipContentStyle } from '../chartTheme';
import type { OverviewResponse } from '../api';

type Dist = OverviewResponse['priorityDistribution'];

const COLOR_BY_PRIORITY: Record<Dist[number]['priority'], string> = {
  urgent: chartColors.chart4,
  high: chartColors.chart1,
  medium: chartColors.chart2,
  low: chartColors.chart3,
};

const LABELS: Record<Dist[number]['priority'], string> = {
  urgent: '紧急',
  high: '高',
  medium: '中',
  low: '低',
};

export default function PriorityDonut({ data }: { data: Dist }) {
  const total = data.reduce((s, d) => s + d.count, 0);
  const filtered = data.filter((d) => d.count > 0).map((d) => ({
    ...d,
    label: LABELS[d.priority],
  }));

  return (
    <div className="glass-panel rounded-[12px] p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[14px] font-semibold" style={{ color: 'var(--color-foreground)' }}>
          用例优先级分布
        </h3>
        <span className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
          共 {total}
        </span>
      </div>
      {total === 0 ? (
        <p className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>暂无用例</p>
      ) : (
        <div style={{ width: '100%', height: 220 }}>
          <ResponsiveContainer>
            <PieChart>
              <Tooltip contentStyle={tooltipContentStyle} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Pie
                data={filtered}
                dataKey="count"
                nameKey="label"
                innerRadius={48}
                outerRadius={80}
                paddingAngle={2}
              >
                {filtered.map((d) => (
                  <Cell key={d.priority} fill={COLOR_BY_PRIORITY[d.priority]} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}