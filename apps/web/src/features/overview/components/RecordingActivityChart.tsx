import { useTranslation } from 'react-i18next';
import { Panel } from './Panel';
import MeterBar from './MeterBar';
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
  httpRequest: 'recordingKindHttpRequest',
};

/** 录制活动：按次数排序的排名清单 + 细条。主图（通过率趋势）之外的数据一律降级为清单，不再开第二张大图。 */
export default function RecordingActivityChart({ data }: { data: Rec }) {
  const { t } = useTranslation();
  const sorted = [...data].sort((a, b) => b.count - a.count);
  const max = Math.max(...sorted.map((d) => d.count), 1);

  return (
    <Panel title={t('overview:recordingTitle')}>
      {sorted.length === 0 ? (
        <p className="py-8 text-center text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
          {t('overview:recordingEmpty')}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {sorted.map((d) => (
            <div key={d.kind} className="grid grid-cols-[72px_minmax(0,1fr)_32px] items-center gap-2">
              <span className="truncate text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
                {KIND_I18N[d.kind] ? t(`overview:${KIND_I18N[d.kind]}`) : d.kind}
              </span>
              <MeterBar pct={(d.count / max) * 100} color="var(--muted-foreground)" size="sm" />
              <span
                className="text-right text-[12px] font-semibold tabular-nums"
                style={{ color: 'var(--foreground)' }}
              >
                {d.count}
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
