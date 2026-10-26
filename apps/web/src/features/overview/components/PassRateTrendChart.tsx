import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from 'recharts';
import { useTranslation } from 'react-i18next';
import { chartColors, tooltipContentStyle } from '../chartTheme';
import { Panel } from './Panel';
import type { OverviewResponse } from '../api';

type Trend = OverviewResponse['trend'];

/** 双通过率三线趋势：最终通过（chart-1 主线）/ 一次通过（chart-2 虚线）/ 失败（chart-3 细线）。
 *  当日无执行（total=0）置 null，connectNulls 跨接空档。 */
export default function PassRateTrendChart({ data }: { data: Trend }) {
  const { t } = useTranslation();
  const rows = data.map((d) => ({
    date: d.date,
    // 预先四舍五入到 1 位小数：Tooltip 直接展示，避免长小数
    passRate: d.total ? Math.round((d.passed / d.total) * 1000) / 10 : null,
    firstPassRate: d.total ? Math.round((d.firstPassed / d.total) * 1000) / 10 : null,
    failedRate: d.total ? Math.round((d.failed / d.total) * 1000) / 10 : null,
  }));
  return (
    <Panel title={t('overview:passRateTrendTitle')} subtitle={t('overview:passRateTrendDays', { count: data.length })}>
      <div style={{ width: '100%', height: 240 }}>
        <ResponsiveContainer>
          <ComposedChart data={rows} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
            <defs>
              <linearGradient id="passRateTrendFinal" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={chartColors.chart1} stopOpacity={0.2} />
                <stop offset="100%" stopColor={chartColors.chart1} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={chartColors.border} strokeDasharray="3 3" />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: chartColors.foregroundMuted }} />
            <YAxis
              domain={[0, 100]}
              tick={{ fontSize: 11, fill: chartColors.foregroundMuted }}
              tickFormatter={(v: number) => `${v}%`}
            />
            <Tooltip contentStyle={tooltipContentStyle} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Area
              type="monotone"
              dataKey="passRate"
              name={t('overview:trendLegendFinal')}
              stroke={chartColors.chart1}
              strokeWidth={2.2}
              fill="url(#passRateTrendFinal)"
              connectNulls
              dot={false}
              activeDot={{ r: 4 }}
            />
            <Line
              type="monotone"
              dataKey="firstPassRate"
              name={t('overview:trendLegendFirst')}
              stroke={chartColors.chart2}
              strokeWidth={1.6}
              strokeDasharray="5 4"
              dot={false}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="failedRate"
              name={t('overview:trendLegendFailed')}
              stroke={chartColors.chart3}
              strokeWidth={1.4}
              strokeOpacity={0.8}
              dot={false}
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}
