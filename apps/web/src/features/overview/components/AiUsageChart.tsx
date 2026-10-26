import {
  ComposedChart,
  Bar,
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

type AiUsage = OverviewResponse['aiUsage'];

/** AI 用量：日 bar = AI 调用次数，line = 自愈成功步数。 */
export default function AiUsageChart({ data, days }: { data: AiUsage; days: number }) {
  const { t } = useTranslation();
  return (
    <Panel title={t('overview:aiUsageTitle')} subtitle={t('overview:aiUsageRange', { days })}>
      <div style={{ width: '100%', height: 200 }}>
        <ResponsiveContainer>
          <ComposedChart data={data}>
            <CartesianGrid stroke={chartColors.border} strokeDasharray="3 3" />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: chartColors.foregroundMuted }} />
            <YAxis tick={{ fontSize: 11, fill: chartColors.foregroundMuted }} allowDecimals={false} />
            <Tooltip contentStyle={tooltipContentStyle} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar
              dataKey="calls"
              name={t('overview:aiUsageCalls')}
              fill={chartColors.chart1}
              radius={[4, 4, 0, 0]}
            />
            <Line
              type="monotone"
              dataKey="healedSteps"
              name={t('overview:aiUsageHealedSteps')}
              stroke={chartColors.chart2}
              strokeWidth={2}
              dot
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}
