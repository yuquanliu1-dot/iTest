import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { useNavigate } from 'react-router-dom';
import { chartColors, tooltipContentStyle } from '../chartTheme';
import type { OverviewResponse } from '../api';

type Top = OverviewResponse['topFailures'];

export default function TopFailuresChart({
  data,
  latestReportByCase,
  projectId,
}: {
  data: Top;
  latestReportByCase: Map<string, string>;
  projectId: string;
}) {
  const navigate = useNavigate();

  if (data.length === 0) {
    return (
      <div
        className="glass-panel rounded-[var(--radius-md)] p-5 flex flex-col items-center justify-center"
        style={{ minHeight: 220 }}
      >
        <h3 className="text-[14px] font-semibold mb-2" style={{ color: 'var(--color-foreground)' }}>
          失败 Top 5
        </h3>
        <p className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>
          近 14 天无失败用例 🎉
        </p>
      </div>
    );
  }

  const chartData = data.map((d) => ({
    name: d.caseTitle.length > 12 ? `${d.caseTitle.slice(0, 12)}…` : d.caseTitle,
    value: d.failureCount,
    caseId: d.caseId,
  }));

  return (
    <div className="glass-panel rounded-[var(--radius-md)] p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[14px] font-semibold" style={{ color: 'var(--color-foreground)' }}>
          失败 Top 5
        </h3>
        <span className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
          近 14 天
        </span>
      </div>
      <div style={{ width: '100%', height: 220 }}>
        <ResponsiveContainer>
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ top: 8, right: 16, left: 16, bottom: 0 }}
          >
            <CartesianGrid stroke={chartColors.border} strokeDasharray="3 3" />
            <XAxis
              type="number"
              tick={{ fontSize: 11, fill: chartColors.foregroundMuted }}
              allowDecimals={false}
            />
            <YAxis
              type="category"
              dataKey="name"
              tick={{ fontSize: 11, fill: chartColors.foregroundSecondary }}
              width={90}
            />
            <Tooltip contentStyle={tooltipContentStyle} />
            <Bar
              dataKey="value"
              fill={chartColors.chart1}
              radius={[0, 4, 4, 0]}
              cursor="pointer"
              onClick={(d) => {
                const payload = d as { caseId?: string };
                const reportId = payload.caseId ? latestReportByCase.get(payload.caseId) : undefined;
                if (reportId) navigate(`/p/${projectId}/reports/${reportId}`);
              }}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}