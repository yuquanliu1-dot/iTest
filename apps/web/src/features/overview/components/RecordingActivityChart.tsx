import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { useTranslation } from 'react-i18next';
import { chartColors, tooltipContentStyle } from '../chartTheme';
import type { OverviewResponse } from '../api';

type Rec = OverviewResponse['recordingActivity'];

// 与 packages/shared step-dsl.ts 的 StepAction kind 对齐;未列出的 kind 回退显示原始值。
const KIND_I18N: Record<string, string> = {
  navigate: 'recordingKindNavigate',
  click: 'recordingKindClick',
  fill: 'recordingKindFill',
  hover: 'recordingKindHover',
  waitFor: 'recordingKindWaitFor',
  assertText: 'recordingKindAssertText',
  assertVisible: 'recordingKindAssertVisible',
  screenshot: 'recordingKindScreenshot',
  check: 'recordingKindCheck',
  select: 'recordingKindSelect',
  upload: 'recordingKindUpload',
  switchTab: 'recordingKindSwitchTab',
  aiTask: 'recordingKindAiTask',
  assertJson: 'recordingKindAssertJson',
  extract: 'recordingKindExtract',
  queryDb: 'recordingKindQueryDb',
  observeLog: 'recordingKindObserveLog',
};

export default function RecordingActivityChart({ data }: { data: Rec }) {
  const { t } = useTranslation();
  if (data.length === 0) {
    return (
      <div className="bg-card border border-[var(--border)] rounded-[var(--radius-md)] p-5">
        <h3 className="text-[14px] font-semibold mb-3" style={{ color: 'var(--foreground)' }}>
          {t('overview:recordingTitle')}
        </h3>
        <p className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
          {t('overview:recordingEmpty')}
        </p>
      </div>
    );
  }

  const chartData = data.map((d) => ({
    name: KIND_I18N[d.kind] ? t(`overview:${KIND_I18N[d.kind]}`) : d.kind,
    value: d.count,
  }));

  return (
    <div className="bg-card border border-[var(--border)] rounded-[var(--radius-md)] p-5">
      <h3 className="text-[14px] font-semibold mb-3" style={{ color: 'var(--foreground)' }}>
        {t('overview:recordingTitle')}
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