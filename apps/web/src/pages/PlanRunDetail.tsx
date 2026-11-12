import { useParams, useNavigate } from 'react-router-dom';
import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { localizeApiError } from '../i18n';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import Button from '../components/ui/Button';
import StatusPill from '../components/ui/StatusPill';
import EmptyState from '../components/ui/EmptyState';
import LiveViewCard from '../components/LiveViewCard';
import RcaBlock from '../components/RcaBlock';
import ReportStepTimeline, { type StepResult } from '../components/report/ReportStepTimeline';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/Modal';
import { fullDateTime } from '../lib/format';
import { creatorName } from '../lib/creatorName';

export default function PlanRunDetail() {
  const { id, runId, projectId, versionId } = useParams<{ id: string; runId: string; projectId: string; versionId: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useUIStore((s) => s.showToast);
  const [showDelete, setShowDelete] = useState(false);
  const { data: run, isLoading, isError, error } = useQuery({
    queryKey: ['planRun', runId],
    queryFn: () => api.planRuns.get(runId!),
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 2000 : false),
  });

  // ── Case switcher (modeled on the dataset row switcher: chip + status dot + follow execution) ──────────────
  // Follow = the selection auto-switches to the case currently executing; manually clicking a chip stops following, "back to latest" restores it.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  // Row selection for data-driven cases (remembered by plan_run_case id, switching cases does not interfere); if never manually picked → running row ?? first row
  const [rowSel, setRowSel] = useState<Record<string, number>>({});
  const cases = run?.cases ?? [];
  // Group sections: sort by (group order, in-group order) then cluster consecutive items by groupId; legacy runs with all-null groupId → single section, no group name shown.
  const ordered = [...cases].sort((a, b) => (a.groupOrder ?? 0) - (b.groupOrder ?? 0) || a.order - b.order);
  const sections: Array<{ key: string; name: string; items: typeof ordered }> = [];
  for (const c of ordered) {
    const key = c.groupId ?? 'legacy';
    const last = sections[sections.length - 1];
    if (last && last.key === key) last.items.push(c);
    else sections.push({ key, name: c.groupName ?? '', items: [c] });
  }
  const activeCase = cases.find((c) => c.status === 'running') ?? null;
  const selected = follow
    ? activeCase ?? cases.find((c) => c.status === 'failed') ?? ordered[0]
    : cases.find((c) => c.id === selectedId) ?? ordered[0];
  const curIdx = ordered.findIndex((c) => c.id === selected?.id);
  const selectCase = (id: string) => {
    setFollow(false);
    setSelectedId(id);
  };
  const gotoCase = (delta: number) => {
    const next = ordered[curIdx + delta];
    if (next) selectCase(next.id);
  };
  const selRowIds = selected?.reportIds ?? [];
  const runningRow = selected ? (selected.rowStatuses ?? []).findIndex((s) => s === 'running') : -1;
  const rowIdx = selected
    ? Math.min(rowSel[selected.id] ?? (runningRow >= 0 ? runningRow : 0), Math.max(selRowIds.length - 1, 0))
    : 0;
  const viewReportId = selRowIds.length > 1 ? selRowIds[rowIdx] ?? null : selected?.reportId ?? null;

  // The selected case's report (shares the queryKey cache with the report detail page): 2s polling while running, steps appear one by one
  const { data: report, isLoading: reportLoading } = useQuery({
    queryKey: ['report', viewReportId],
    queryFn: () => api.reports.get(viewReportId!),
    enabled: !!viewReportId,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 2000 : false),
  });

  // Abort capability moved here from the plan detail page: running jumps straight to this page, abort happens in place while running.
  const cancel = useMutation({
    mutationFn: () => api.planRuns.cancel(runId!),
    onSuccess: () => {
      toast(t('plans:abortRequested'), 'success');
      qc.invalidateQueries({ queryKey: ['planRun', runId] });
      qc.invalidateQueries({ queryKey: ['executions'] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  // Delete this run: member reports are deleted along with it (backend semantics), then back to the execution history list
  const remove = useMutation({
    mutationFn: () => api.planRuns.remove(runId!),
    onSuccess: () => {
      toast(t('plans:runDeletedToast'), 'success');
      qc.invalidateQueries({ queryKey: ['executions'] });
      qc.invalidateQueries({ queryKey: ['reports'] });
      qc.invalidateQueries({ queryKey: ['stats', projectId] });
      navigate(`/p/${projectId}/v/${versionId}/reports`);
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  if (isError) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--muted-foreground)', fontSize: 13 }}>
        {t('common:loadFailed')}：{error?.message ?? t('common:unknownError')}
      </div>
    );
  }

  if (isLoading || !run) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--muted-foreground)' }}>
        <Icon name="loader" size={16} className="animate-spin" />
        <span style={{ marginLeft: 8 }}>{t('cases:loading')}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 px-6 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <Button variant="ghost" size="sm" onClick={() => navigate(`/p/${projectId}/v/${versionId}/reports`)}>
          <Icon name="chevronLeft" size={12} />
          {t('plans:backToHistory')}
        </Button>
        <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
        {/* planName is null when the plan was deleted, fall back to the generic "plan run" */}
        <h1 className="text-[16px] font-semibold truncate" style={{ color: 'var(--foreground)' }}>{run.planName ?? t('plans:planRunTitle')}</h1>
        <StatusPill status={run.status}>{t(`cases:status.${run.status}`)}</StatusPill>
        <div className="flex-1" />
        {run.status === 'running' && (
          <Button variant="ghost" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
            <Icon name="pause" size={12} />
            {cancel.isPending ? t('plans:aborting') : t('plans:abort')}
          </Button>
        )}
        {/* No delete while running: the executor is still writing the member and report tables; deleting then would leave dangling data */}
        {run.status !== 'running' && (
          <Button
            variant="ghost"
            onClick={() => setShowDelete(true)}
            style={{ color: 'var(--destructive)' }}
            aria-label={t('plans:deleteRunTitle')}
            title={t('plans:deleteRunTitle')}
          >
            <Icon name="trash" size={12} />
          </Button>
        )}
        <span className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
          {fullDateTime(run.startedAt)} · {run.durationMs ?? 0} ms
          {run.triggeredBy ? t('plans:triggeredBy', { creator: creatorName(run.triggeredBy) }) : ''}
        </span>
      </div>

      {/* flex-col children default to flex-shrink:1; over-tall content gets squashed and swallows its overflow into itself
          (timeline card h < scrollH yet cannot scroll). shrink-0 keeps children at natural height,
          and the overflow scrolls normally in this container's overflow-y-auto. */}
      <div className="flex-1 min-h-0 overflow-y-auto p-6 flex flex-col gap-4">
        {/* Live view while running: refetchInterval polls run.status every 2s; while running the <img> connects directly to the MJPEG stream;
            on finish it freezes the last frame + a "replay" button (recorded replay, no autoplay). */}
        <div className="shrink-0">
          <LiveViewCard
            liveUrl={api.planRuns.liveUrl(run.id)}
            replayUrl={(speed) => api.planRuns.replayUrl(run.id, speed)}
            replayMetaUrl={api.planRuns.replayMetaUrl(run.id)}
            running={run.status === 'running'}
          />
        </div>
        <div className="shrink-0 bg-card border rounded-[var(--radius-md)] p-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
          {run.summary ?? t('plans:executing')}
        </div>

        {/* Case switcher: chips pick the case; the case's detailed execution report (per-step progress) renders in place below.
            Style and semantics modeled on the report detail page's dataset row switcher. */}
        {cases.length === 0 ? (
          <div className="shrink-0 bg-card border rounded-[var(--radius-md)] overflow-hidden">
            <EmptyState icon="listChecks" title={t('cases:noStepsYet')} />
          </div>
        ) : (
          <>
            <div className="shrink-0 flex items-center gap-2 flex-wrap bg-card border rounded-[var(--radius-md)] px-4 py-2">
              <span className="text-[12px] font-medium shrink-0" style={{ color: 'var(--muted-foreground)' }}>
                {t('plans:caseSelector')}
              </span>
              <div className="flex items-center gap-1 flex-wrap">
                {sections.map((sec) => (
                  <Fragment key={sec.key}>
                    {sec.key !== 'legacy' && (
                      <>
                        <span className="text-[11px] font-semibold shrink-0">{sec.name}</span>
                        <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
                      </>
                    )}
                    {sec.items.map((c) => {
                      const cur = c.id === selected?.id;
                      const dotColor =
                        c.status === 'passed' ? 'var(--success)'
                        : c.status === 'failed' ? 'var(--destructive)'
                        : c.status === 'running' ? 'var(--primary)'
                        : 'var(--muted-foreground)';
                      // Cases skipped by fail_fast strategy: small annotation inside the chip + tooltip explanation (backend error text `skipped: group/plan fail_fast`)
                      const skipNote =
                        c.error?.includes('plan fail_fast') ? t('plans:groupSkippedByPlan')
                        : c.error?.includes('group fail_fast') ? t('plans:groupSkippedByGroup')
                        : null;
                      return (
                        <button
                          key={c.id}
                          type="button"
                          className="rowchip max-w-[260px]"
                          style={cur ? { borderColor: 'var(--primary)', boxShadow: '0 0 0 2px var(--primary-soft)' } : undefined}
                          onClick={() => selectCase(c.id)}
                          title={skipNote ? `${c.caseTitle ?? c.caseId} · ${skipNote}` : c.caseTitle ?? c.caseId}
                        >
                          <span className="font-mono shrink-0">#{c.order}</span>
                          {c.stepKind === 'login_prepare' && (
                            <span className="shrink-0" style={{ color: 'var(--muted-foreground)' }}>{t('plans:login')}</span>
                          )}
                          <span className="truncate min-w-0">{c.caseTitle ?? t('plans:deletedCase')}</span>
                          {skipNote && (
                            <span className="shrink-0" style={{ color: 'var(--muted-foreground)' }}>{skipNote}</span>
                          )}
                          <span
                            className={c.status === 'running' ? 'status-pulse' : undefined}
                            style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor, flexShrink: 0 }}
                          />
                        </button>
                      );
                    })}
                  </Fragment>
                ))}
              </div>
              <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
              <Button variant="ghost" size="sm" disabled={curIdx <= 0} onClick={() => gotoCase(-1)}>
                <Icon name="chevronLeft" size={12} />
              </Button>
              <Button variant="ghost" size="sm" disabled={curIdx < 0 || curIdx >= cases.length - 1} onClick={() => gotoCase(1)}>
                <Icon name="chevronRight" size={12} />
              </Button>
              <span className="text-[12px] font-medium" style={{ color: 'var(--muted-foreground)', fontVariantNumeric: 'tabular-nums' }}>
                {curIdx + 1}/{cases.length}
              </span>
              <div className="flex-1" />
              {activeCase && (follow ? (
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] rounded-full" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}>
                  <span className="status-pulse" style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor' }} />
                  {t('reports:detail.following')}
                </span>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setFollow(true)}>
                  {t('reports:detail.backToLatest')}
                  <Icon name="chevronRight" size={12} />
                </Button>
              ))}
            </div>

            {/* The selected case's detailed execution report */}
            {selected && (
              <div className="shrink-0 flex flex-col gap-3">
                <div className="bg-card border rounded-[var(--radius-md)] px-4 py-2 flex items-center gap-2 flex-wrap">
                  <span className="text-[13px] font-medium" style={{ color: 'var(--foreground)' }}>
                    {selected.caseTitle ?? t('plans:deletedCase')}
                  </span>
                  <span className="font-mono text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{selected.caseId.slice(0, 8)}</span>
                  <StatusPill status={selected.status} pulse={selected.status === 'running'}>{t(`cases:status.${selected.status}`)}</StatusPill>
                  <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{selected.durationMs ?? 0} ms</span>
                  {/* Data-driven case: row-number chips (row status dots converge via polling); row reports are displayed inline in the step timeline below */}
                  {(selected.reportIds?.length ?? 0) > 1 && (
                    <div className="flex items-center gap-1 flex-wrap">
                      {(selected.reportIds ?? []).map((rid, i) => {
                        const st = selected.rowStatuses?.[i];
                        const rowDot =
                          st === 'passed' ? 'var(--success)'
                          : st === 'failed' ? 'var(--destructive)'
                          : st === 'running' ? 'var(--primary)'
                          : 'var(--muted-foreground)';
                        return (
                          <button
                            key={rid}
                            type="button"
                            className="rowchip"
                            style={i === rowIdx ? { borderColor: 'var(--primary)', boxShadow: '0 0 0 2px var(--primary-soft)' } : undefined}
                            onClick={() => setRowSel((m) => ({ ...m, [selected.id]: i }))}
                            title={t('plans:rowLabel', { index: i + 1 })}
                          >
                            {i + 1}
                            <span
                              className={st === 'running' ? 'status-pulse' : undefined}
                              style={{ width: 6, height: 6, borderRadius: '50%', background: rowDot, flexShrink: 0 }}
                            />
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <div className="flex-1" />
                  {viewReportId && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => navigate(`/p/${projectId}/v/${versionId}/reports/${viewReportId}`)}
                    >
                      {t('plans:openFullReport')}
                      <Icon name="chevronRight" size={12} />
                    </Button>
                  )}
                </div>
                {selected.error && (
                  <div
                    className="text-[12px] px-3 py-2 rounded-[var(--radius-sm)]"
                    style={{ background: 'var(--destructive-soft-strong)', color: 'var(--destructive)' }}
                  >
                    {selected.error}
                  </div>
                )}
                {!selected.error && selected.lastAssertion && (
                  <div
                    className="text-[12px] px-3 py-2 rounded-[var(--radius-sm)] truncate"
                    style={{ color: 'var(--muted-foreground)', background: 'var(--muted)' }}
                    title={selected.lastAssertion}
                  >
                    {selected.lastAssertion}
                  </div>
                )}
                {selected.status === 'failed' && selected.rca && (
                  <div className="bg-card border rounded-[var(--radius-md)] p-4">
                    <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-2" style={{ color: 'var(--muted-foreground)' }}>
                      {t('reports:rca.title')}
                    </div>
                    <RcaBlock rca={selected.rca} threadJump assistantPath={`/p/${projectId}/v/${versionId}/assistant`} />
                  </div>
                )}
                <div className="bg-card border rounded-[var(--radius-md)] overflow-hidden">
                  <div className="px-5 py-[10px] hairline-bottom" style={{ background: 'var(--muted)' }}>
                    <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--muted-foreground)' }}>
                      {t('reports:detail.stepTimeline')}
                    </span>
                  </div>
                  {viewReportId ? (
                    reportLoading ? (
                      <div className="flex flex-col items-center justify-center gap-2 px-5 py-14" style={{ color: 'var(--muted-foreground)' }}>
                        <Icon name="loader" size={16} className="animate-spin" />
                      </div>
                    ) : (
                      <ReportStepTimeline
                        stepResults={(report?.stepResults as StepResult[]) ?? []}
                        isRunning={report?.status === 'running'}
                      />
                    )
                  ) : (
                    // No report row yet: queued awaiting execution (spinner while running, static copy otherwise)
                    <div className="flex flex-col items-center justify-center gap-2 px-5 py-14" style={{ color: 'var(--muted-foreground)' }}>
                      <Icon name="loader" size={16} className={selected.status === 'running' ? 'animate-spin' : undefined} />
                      <span style={{ fontSize: 13 }}>{t('plans:caseQueued')}</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <Dialog open={showDelete} onOpenChange={setShowDelete}>
        <DialogContent style={{ maxWidth: 420 }}>
          <DialogHeader><DialogTitle>{t('plans:deleteRunTitle')}</DialogTitle></DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
            {t('plans:deleteRunConfirm', { id: runId?.slice(0, 8) ?? '' })}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowDelete(false)}>{t('common:cancel')}</Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => { setShowDelete(false); remove.mutate(); }}
            >
              {remove.isPending ? t('cases:deleting') : t('cases:confirmDelete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}