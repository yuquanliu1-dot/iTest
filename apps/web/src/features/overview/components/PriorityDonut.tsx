import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { useTranslation } from 'react-i18next';
import { chartColors, tooltipContentStyle } from '../chartTheme';
import type { OverviewResponse } from '../api';

type Dist = OverviewResponse['priorityDistribution'];

const COLOR_BY_PRIORITY: Record<Dist[number]['priority'], string> = {
  urgent: chartColors.chart4,
  high: chartColors.chart1,
  medium: chartColors.chart2,
  low: chartColors.chart3,
};

const LABEL_KEY: Record<Dist[number]['priority'], string> = {
  urgent: 'priorityUrgent',
  high: 'priorityHigh',
  medium: 'priorityMedium',
  low: 'priorityLow',
};

export default function PriorityDonut({ data }: { data: Dist }) {
  const { t } = useTranslation();
  const total = data.reduce((s, d) => s + d.count, 0);
  const filtered = data.filter((d) => d.count > 0).map((d) => ({
    ...d,
    label: t(`overview:${LABEL_KEY[d.priority]}`),
  }));

  return (
    <div className="bg-card border border-[var(--border)] rounded-[var(--radius-md)] p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[14px] font-semibold" style={{ color: 'var(--foreground)' }}>
          {t('overview:priorityTitle')}
        </h3>
        <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
          {t('overview:priorityTotal', { count: total })}
        </span>
      </div>
      {total === 0 ? (
        <p className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>{t('overview:priorityEmpty')}</p>
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