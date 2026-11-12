import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/Table';
import StatusPill from '../../../components/ui/StatusPill';
import { Panel } from './Panel';
import MeterBar from './MeterBar';
import { RCA_CATEGORY_COLOR, RCA_CATEGORY_BG } from '../chartTheme';
import { formatPct } from '../format';
import type { OverviewResponse } from '../api';

type Plan = OverviewResponse['plans'][number];

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

/** Plan overview table: status badge + pass rate (green = verdict; 0% draws no empty bar) + latest RCA badge + trigger method. Clicking a row opens the plan detail. */
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
        <p className="py-6 text-center text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
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
                <TableCell className="max-w-[220px] truncate font-medium">{p.name}</TableCell>
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
                      <span className="text-[12px] font-semibold tabular-nums">{formatPct(p.passRate)}%</span>
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
                        color: RCA_CATEGORY_COLOR[p.lastRcaCategory] ?? 'var(--muted-foreground)',
                        background: RCA_CATEGORY_BG[p.lastRcaCategory] ?? 'var(--muted)',
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
                    <span className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
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
