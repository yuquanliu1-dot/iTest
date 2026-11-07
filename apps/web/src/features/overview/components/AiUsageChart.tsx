import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useTranslation } from 'react-i18next';
import { chartColors, tooltipContentStyle } from '../chartTheme';
import { Panel } from './Panel';
import type { OverviewResponse } from '../api';

type AiUsage = OverviewResponse['aiUsage'];

/** 「2026-10-09」→「10-09」：轴上只留月日，全量日期留给 tooltip */
function shortDate(v: string): string {
  return v.length >= 10 ? v.slice(5) : v;
}

/** AI 用量：日灰柱 = AI 调用次数，绿线 = 自愈成功步数（绿=好结果，与通过率趋势同义）。 */
export default function AiUsageChart({ data, days }: { data: AiUsage; days: number }) {
  const { t } = useTranslation();
  return (
    <Panel title={t('overview:aiUsageTitle')} subtitle={t('overview:aiUsageRange', { days })}>
      <div
        className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]"
        style={{ color: 'var(--muted-foreground)' }}
      >
        <span className="flex items-center gap-2">
          <span className="h-2.5 w-[3px] rounded-[1px]" style={{ background: chartColors.neutral, opacity: 0.55 }} />
          {t('overview:aiUsageCalls')}
        </span>
        <span className="flex items-center gap-2">
          <span className="h-[2px] w-3.5 rounded-full" style={{ background: chartColors.chart1 }} />
          {t('overview:aiUsageHealedSteps')}
        </span>
      </div>
      <div style={{ width: '100%', height: 200 }}>
        <ResponsiveContainer>
          <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={chartColors.border} strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: chartColors.foregroundMuted }}
              tickFormatter={shortDate}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 11, fill: chartColors.foregroundMuted }}
              allowDecimals={false}
              width={32}
            />
            <Tooltip contentStyle={tooltipContentStyle} />
            <Bar
              dataKey="calls"
              name={t('overview:aiUsageCalls')}
              fill={chartColors.neutral}
              fillOpacity={0.55}
              radius={[1, 1, 0, 0]}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="healedSteps"
              name={t('overview:aiUsageHealedSteps')}
              stroke={chartColors.chart1}
              strokeWidth={1.8}
              dot={false}
              activeDot={{ r: 3 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}
