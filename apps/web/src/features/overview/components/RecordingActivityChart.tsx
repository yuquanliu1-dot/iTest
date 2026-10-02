import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { chartColors, tooltipContentStyle } from '../chartTheme';
import type { OverviewResponse } from '../api';

type Rec = OverviewResponse['recordingActivity'];

const KIND_LABEL: Record<string, string> = {
  click: '点击',
  input: '输入',
  hover: '悬浮',
  check: '勾选',
  upload: '上传',
  assert: '断言',
  variable: '变量',
};

export default function RecordingActivityChart({ data }: { data: Rec }) {
  if (data.length === 0) {
    return (
      <div className="glass-panel rounded-[12px] p-5">
        <h3 className="text-[14px] font-semibold mb-3" style={{ color: 'var(--color-foreground)' }}>
          录制活动
        </h3>
        <p className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>
          录制活动统计将在后续版本接入
        </p>
      </div>
    );
  }

  const chartData = data.map((d) => ({
    name: KIND_LABEL[d.kind] ?? d.kind,
    value: d.count,
  }));

  return (
    <div className="glass-panel rounded-[12px] p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
      <h3 className="text-[14px] font-semibold mb-3" style={{ color: 'var(--color-foreground)' }}>
        录制活动
      </h3>
      <div style={{ width: '100%', height: 200 }}>
        <ResponsiveContainer>
          <BarChart data={chartData}>
            <CartesianGrid stroke={chartColors.border} strokeDasharray="3 3" />
            <XAxis
              dataKey="name"
              tick={{ fontSize: 11, fill: chartColors.foregroundMuted }}
            />
            <YAxis
              tick={{ fontSize: 11, fill: chartColors.foregroundMuted }}
              allowDecimals={false}
            />
            <Tooltip contentStyle={tooltipContentStyle} />
            <Bar dataKey="value" fill={chartColors.chart2} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}