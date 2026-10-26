import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/Table';
import StatusPill from '../../../components/ui/StatusPill';
import { Panel } from './Panel';
import MeterBar from './MeterBar';
import { formatPct } from '../format';
import type { OverviewResponse } from '../api';

type Plan = OverviewResponse['plans'][number];

// RCA 徽章配色与主体 RCA 展示一致（RcaBlock.tsx）。
const RCA_COLOR: Record<string, string> = {
  system_defect: 'var(--destructive)',
  environment: 'var(--warning)',
  case_issue: 'var(--muted-foreground)',
  other: 'var(--muted-foreground)',
};

const RCA_BG: Record<string, string> = {
  system_defect: 'var(--destructive-soft)',
  environment: 'var(--warning-soft)',
  case_issue: 'var(--muted)',
  other: 'var(--muted)',
};

const RCA_LABEL: Record<string, string> = {
  case_issue: 'overview:rcaCaseIssue',
  environment: 'overview:rcaEnvironment',
  system_defect: 'overview:rcaSystemDefect',
  other: 'overview:rcaOther',
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const COLUMNS = [
  'planColName',
  'planColStatus',
  'planColPassRate',
  'planColCases',
  'planColLastRun',
  'planColRca',
  'planColTrigger',
];

/** 计划概览表：状态徽标 + 通过率进度条 + 最近 RCA 徽标 + 触发方式。行点击进计划详情。 */
export default function PlanOverviewTable({
  plans,
  schedulesCount,
  projectId,
}: {
  plans: Plan[];
  schedulesCount: number;
  projectId: string;
}) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { versionId } = useParams<{ versionId: string }>();

  return (
    <Panel
      title={t('overview:planTableTitle')}
      subtitle={
        <>
          {t('overview:planTableSub', { count: plans.length })}
          {schedulesCount > 0 && (
            <span style={{ color: 'var(--primary)', marginLeft: 8 }}>
              {t('overview:planTableSchedules', { count: schedulesCount })}
            </span>
          )}
        </>
      }
      bodyClassName="-mx-1"
    >
      {plans.length === 0 ? (
        <p className="py-6 text-center text-[12.5px]" style={{ color: 'var(--muted-foreground)' }}>
          {t('overview:planEmpty')}
        </p>
      ) : (
        <Table containerClassName="overflow-x-auto">
          <TableHeader>
            <TableRow>
              {COLUMNS.map((key) => (
                <TableHead key={key}>{t(`overview:${key}`)}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {plans.map((p) => (
              <TableRow
                key={p.id}
                onClick={() => navigate(`/p/${projectId}/v/${versionId}/plans/${p.id}`)}
                className="cursor-pointer"
              >
                <TableCell className="max-w-[220px] truncate font-semibold">{p.name}</TableCell>
                <TableCell>
                  {p.lastStatus ? (
                    <StatusPill status={p.lastStatus} pulse={p.lastStatus === 'running'}>
                      {t(`cases:status.${p.lastStatus}`, { defaultValue: p.lastStatus })}
                    </StatusPill>
                  ) : (
                    <StatusPill tone="muted">{t('overview:planNotRun')}</StatusPill>
                  )}
                </TableCell>
                <TableCell>
                  {p.lastRunAt ? (
                    <span className="flex items-center gap-2">
                      <span className="inline-block w-20">
                        <MeterBar pct={p.passRate * 100} color="var(--chart-1)" size="sm" />
                      </span>
                      <span className="text-[12.5px] font-semibold tabular-nums">
                        {formatPct(p.passRate)}%
                      </span>
                    </span>
                  ) : (
                    <span style={{ color: 'var(--muted-foreground)' }}>—</span>
                  )}
                </TableCell>
                <TableCell className="tabular-nums">{p.totalCases}</TableCell>
                <TableCell className="font-mono text-[12px] text-muted-foreground">
                  {p.lastRunAt ? fmtTime(p.lastRunAt) : '—'}
                </TableCell>
                <TableCell>
                  {p.lastRcaCategory ? (
                    <span
                      className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium"
                      style={{
                        color: RCA_COLOR[p.lastRcaCategory] ?? 'var(--muted-foreground)',
                        background: RCA_BG[p.lastRcaCategory] ?? 'var(--muted)',
                      }}
                    >
                      {t(RCA_LABEL[p.lastRcaCategory] ?? 'overview:rcaOther')}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--muted-foreground)' }}>—</span>
                  )}
                </TableCell>
                <TableCell>
                  {p.triggeredBy ? (
                    <span
                      className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium"
                      style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}
                    >
                      {t(p.triggeredBy === 'schedule' ? 'overview:triggerSchedule' : 'overview:triggerManual')}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--muted-foreground)' }}>—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}
