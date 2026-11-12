import { useTranslation } from 'react-i18next';
import { Panel } from './Panel';
import MeterBar from './MeterBar';
import type { OverviewResponse } from '../api';

type Rec = OverviewResponse['recordingActivity'];

// Aligned with the StepAction kinds in packages/shared step-dsl.ts; kinds not listed fall back to the raw value.
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
  observeLog: 'recordingKindObserveLog',
  httpRequest: 'recordingKindHttpRequest',
};

/** Recording activity: a count-ranked list + thin bars. Anything besides the main chart (pass-rate trend) is demoted to a list; no second big chart. */
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
