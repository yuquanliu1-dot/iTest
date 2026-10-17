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
import type { OverviewResponse } from '../api';

type AI = OverviewResponse['aiActivity'];

export default function AiActivityChart({ data }: { data: AI }) {
  const { t } = useTranslation();
  return (
    <div className="bg-card border border-[var(--border)] rounded-[var(--radius-md)] p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[14px] font-semibold" style={{ color: 'var(--foreground)' }}>
          {t('overview:aiActivityTitle')}
        </h3>
        <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
          {t('overview:aiActivityRange')}
        </span>
      </div>
      <div style={{ width: '100%', height: 200 }}>
        <ResponsiveContainer>
          <ComposedChart data={data}>
            <CartesianGrid stroke={chartColors.border} strokeDasharray="3 3" />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: chartColors.foregroundMuted }} />
            <YAxis
              tick={{ fontSize: 11, fill: chartColors.foregroundMuted }}
              allowDecimals={false}
            />
            <Tooltip contentStyle={tooltipContentStyle} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar
              dataKey="casesGenerated"
              name={t('overview:aiCasesGenerated')}
              fill={chartColors.chart5}
              radius={[4, 4, 0, 0]}
            />
            <Line
              type="monotone"
              dataKey="stepsGenerated"
              name={t('overview:aiStepsGenerated')}
              stroke={chartColors.chart1}
              strokeWidth={2}
              dot
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}