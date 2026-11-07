import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { BarShapeProps } from 'recharts';
import { useTranslation } from 'react-i18next';
import { chartColors, tooltipContentStyle } from '../chartTheme';
import { Panel } from './Panel';
import type { OverviewResponse } from '../api';

type Trend = OverviewResponse['trend'];

/**
 * 通过率趋势：最终通过（chart-1 绿面积）/ 一次通过（chart-2 蓝虚线）/ 失败（destructive 红）。
 *
 * 当日无执行（total=0）置 null 且**不跨接**：线段在空档处断开，
 * 免得把「没跑」画成一条 100% 的平台。空档本身由下方的每日执行量细柱交代。
 */

/** 每日执行量细柱：零执行日不是空白，而是一枚贴在基线上的发丝刻线 */
function VolumeBar(props: BarShapeProps) {
  const { x, y, width, height, value } = props;
  const v = typeof value === 'number' ? value : 0;
  const h = Math.max(height, 1);
  return (
    <rect
      x={x}
      y={y + height - h}
      width={width}
      height={h}
      rx={1}
      fill={v > 0 ? chartColors.neutral : chartColors.border}
      fillOpacity={v > 0 ? 0.55 : 1}
    />
  );
}

/** 静默图例：色块 + 文字，不带 recharts 默认图例的色块边框 */
function LegendItem({
  kind,
  color,
  label,
}: {
  kind: 'area' | 'line' | 'dash' | 'bar';
  color: string;
  label: string;
}) {
  return (
    <span className="flex items-center gap-2">
      {kind === 'area' && (
        <span className="h-2.5 w-3.5 rounded-[2px]" style={{ background: color, opacity: 0.4 }} />
      )}
      {kind === 'line' && (
        <span className="h-[2px] w-3.5 rounded-full" style={{ background: color }} />
      )}
      {kind === 'dash' && (
        <span
          className="h-[2px] w-3.5"
          style={{
            backgroundImage: `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 7px)`,
          }}
        />
      )}
      {kind === 'bar' && (
        <span className="h-2.5 w-[3px] rounded-[1px]" style={{ background: color, opacity: 0.55 }} />
      )}
      <span>{label}</span>
    </span>
  );
}

/** 「2026-10-09」→「10-09」：轴上只留月日，全量日期留给 tooltip */
function shortDate(v: string): string {
  return v.length >= 10 ? v.slice(5) : v;
}

export default function PassRateTrendChart({ data }: { data: Trend }) {
  const { t } = useTranslation();
  const rows = data.map((d) => ({
    date: d.date,
    // 预先四舍五入到 1 位小数：Tooltip 直接展示，避免长小数
    passRate: d.total ? Math.round((d.passed / d.total) * 1000) / 10 : null,
    firstPassRate: d.total ? Math.round((d.firstPassed / d.total) * 1000) / 10 : null,
    failedRate: d.total ? Math.round((d.failed / d.total) * 1000) / 10 : null,
    volume: d.total,
  }));

  return (
    <Panel title={t('overview:passRateTrendTitle')} subtitle={t('overview:passRateTrendDays', { count: data.length })}>
      <div
        className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]"
        style={{ color: 'var(--muted-foreground)' }}
      >
        <LegendItem kind="area" color={chartColors.chart1} label={t('overview:trendLegendFinal')} />
        <LegendItem kind="dash" color={chartColors.chart2} label={t('overview:trendLegendFirst')} />
        <LegendItem kind="line" color={chartColors.destructive} label={t('overview:trendLegendFailed')} />
        <LegendItem kind="bar" color={chartColors.neutral} label={t('overview:trendVolumeLabel')} />
      </div>

      {/* 主图：0–100% 判定线。Y 轴固定 44px 宽，与下方执行量图共用同一绘图区左边界。 */}
      <div style={{ width: '100%', height: 208 }}>
        <ResponsiveContainer>
          <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="passRateTrendFinal" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={chartColors.chart1} stopOpacity={0.2} />
                <stop offset="100%" stopColor={chartColors.chart1} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={chartColors.border} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="date" hide />
            <YAxis
              domain={[0, 100]}
              width={44}
              tick={{ fontSize: 11, fill: chartColors.foregroundMuted }}
              tickFormatter={(v: number) => `${v}%`}
            />
            <Tooltip contentStyle={tooltipContentStyle} />
            <Area
              type="monotone"
              dataKey="passRate"
              name={t('overview:trendLegendFinal')}
              stroke={chartColors.chart1}
              strokeWidth={2.2}
              fill="url(#passRateTrendFinal)"
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
              activeDot={{ r: 3 }}
            />
            <Line
              type="monotone"
              dataKey="failedRate"
              name={t('overview:trendLegendFailed')}
              stroke={chartColors.destructive}
              strokeWidth={1.4}
              dot={false}
              activeDot={{ r: 3 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* 执行量层：与主图同一 x 刻度，零执行日只留基线刻线 */}
      <div style={{ width: '100%', height: 62 }}>
        <ResponsiveContainer>
          <BarChart data={rows} margin={{ top: 4, right: 8, left: 44, bottom: 0 }}>
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: chartColors.foregroundMuted }}
              tickFormatter={shortDate}
              interval="preserveStartEnd"
            />
            <Tooltip
              contentStyle={tooltipContentStyle}
              cursor={{ fill: 'var(--muted)' }}
              labelFormatter={(v) => String(v)}
            />
            <Bar
              dataKey="volume"
              name={t('overview:trendVolumeLabel')}
              barSize={4}
              shape={VolumeBar}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}
