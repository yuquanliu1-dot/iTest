import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import { chartColors, tooltipContentStyle } from '../chartTheme';
import type { OverviewResponse } from '../api';

type Trend = OverviewResponse['trend'];

export default function PassRateTrendChart({ data }: { data: Trend }) {
  return (
    <div className="bg-card border border-[var(--border)] rounded-[var(--radius-md)] p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[14px] font-semibold" style={{ color: 'var(--foreground)' }}>
          通过率趋势
        </h3>
        <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
          近 {data.length} 天
        </span>
      </div>
      <div style={{ width: '100%', height: 220 }}>
        <ResponsiveContainer>
          <AreaChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
            <defs>
              <linearGradient id="passRateTrendPassed" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={chartColors.chart1} stopOpacity={0.6} />
                <stop offset="100%" stopColor={chartColors.chart1} stopOpacity={0} />
              </linearGradient>
              <linearGradient id="passRateTrendFailed" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={chartColors.chart2} stopOpacity={0.4} />
                <stop offset="100%" stopColor={chartColors.chart2} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={chartColors.border} strokeDasharray="3 3" />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: chartColors.foregroundMuted }} />
            <YAxis tick={{ fontSize: 11, fill: chartColors.foregroundMuted }} allowDecimals={false} />
            <Tooltip contentStyle={tooltipContentStyle} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Area type="monotone" dataKey="passed" stroke={chartColors.chart1} fill="url(#passRateTrendPassed)" name="通过" />
            <Area type="monotone" dataKey="failed" stroke={chartColors.chart2} fill="url(#passRateTrendFailed)" name="失败" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
