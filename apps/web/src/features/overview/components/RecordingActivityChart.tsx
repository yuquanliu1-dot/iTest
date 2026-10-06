import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { chartColors, tooltipContentStyle } from '../chartTheme';
import type { OverviewResponse } from '../api';

type Rec = OverviewResponse['recordingActivity'];

// 与 packages/shared step-dsl.ts 的 StepAction kind 对齐;未列出的 kind 回退显示原始值。
const KIND_LABEL: Record<string, string> = {
  navigate: '导航',
  click: '点击',
  fill: '输入',
  hover: '悬浮',
  waitFor: '等待',
  assertText: '断言文本',
  assertVisible: '断言可见',
  screenshot: '截图',
  check: '勾选',
  select: '选择',
  upload: '上传',
  switchTab: '切换标签',
  aiTask: 'AI 任务',
  assertJson: '断言JSON',
  extract: '提取变量',
  queryDb: '查询数据库',
  observeLog: '观察日志',
};

export default function RecordingActivityChart({ data }: { data: Rec }) {
  if (data.length === 0) {
    return (
      <div className="bg-card border border-[var(--border)] rounded-[var(--radius-md)] p-5">
        <h3 className="text-[14px] font-semibold mb-3" style={{ color: 'var(--foreground)' }}>
          录制活动
        </h3>
        <p className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
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
    <div className="bg-card border border-[var(--border)] rounded-[var(--radius-md)] p-5">
      <h3 className="text-[14px] font-semibold mb-3" style={{ color: 'var(--foreground)' }}>
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