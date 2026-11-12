import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { localizeApiError } from '../i18n';
import { useParams, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import Icon from '../components/Icon';
import LiveViewCard from '../components/LiveViewCard';
import RcaBlock from '../components/RcaBlock';
import StatusPill from '../components/ui/StatusPill';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/Modal';
import Button from '../components/ui/Button';
import ReportStepTimeline, { fmtTokens, type StepResult } from '../components/report/ReportStepTimeline';
import { useUIStore } from '../stores/ui';
import { fullDateTime } from '../lib/format';
import { creatorName } from '../lib/creatorName';

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[12px] mb-2 last:mb-0">
      <span className="shrink-0" style={{ color: 'var(--muted-foreground)' }}>{label}</span>
      <span className="text-right truncate" style={{ color: 'var(--muted-foreground)' }}>{value}</span>
    </div>
  );
}

export default function ReportDetail() {
  const { id, projectId, versionId } = useParams<{ id: string; projectId: string; versionId: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useUIStore((s) => s.showToast);
  const [showDelete, setShowDelete] = useState(false);
  // Step lightbox open/close (zoom state lives inside ReportStepTimeline): when open, the dataset row switcher's ←/→ must yield
  const [zoomOpen, setZoomOpen] = useState(false);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['report', id],
    queryFn: () => api.reports.get(id!),
    enabled: !!id,
    // Execution is async: poll every 2s while running; the report converges in place from running → passed/failed
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 2000 : false),
  });

  const remove = useMutation({
    mutationFn: () => api.reports.remove(id!),
    onSuccess: () => {
      toast(t('plans:deletedToast'), 'success');
      qc.invalidateQueries({ queryKey: ['reports'] });
      qc.invalidateQueries({ queryKey: ['executions'] });
      qc.invalidateQueries({ queryKey: ['stats', projectId] });
      navigate(`/p/${projectId}/v/${versionId}/reports`);
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  // ── Dataset row switcher (sibling rows of the same batch + follow execution) ────────────────────────────────
  // Old reports have no datasetBatchId → endpoint returns empty → switcher not rendered; row switching reuses this page (queryKey ['report', id] swaps data in place).
  const [follow, setFollow] = useState(true);
  const batchEnabled = !!data?.datasetBatchId && (data?.datasetSnapshot?.totalRows ?? 1) > 1;
  const batchQuery = useQuery({
    queryKey: ['dataset-batch', data?.datasetBatchId],
    // The endpoint takes the report id (the server reverse-derives the batchId from that row); key is the batchId, so switching rows hits cache without refetch
    queryFn: () => api.reports.datasetBatch(id!),
    enabled: batchEnabled,
    // Batch still has running rows → poll every 2s (same cadence as the report itself): row status convergence = chip dot color + the data source for follow jumping
    refetchInterval: (q) => (q.state.data?.rows.some((r) => r.status === 'running') ? 2000 : false),
  });
  const batchRows = useMemo(() => batchQuery.data?.rows ?? [], [batchQuery.data]);
  // Active row = the running row with the smallest rowIndex (rows execute serially by rowIndex; rows are already sorted ascending by rowIndex)
  const activeRow = batchRows.find((r) => r.status === 'running') ?? null;
  const curRowIdx = batchRows.findIndex((r) => r.id === id);

  // Manual row switch (chip / ‹› / ←→): pause following (same semantics as terminal auto-scroll)
  const gotoRow = (rid: string) => {
    setFollow(false);
    if (rid !== id) navigate(`/p/${projectId}/v/${versionId}/reports/${rid}`);
  };

  // Follow execution: switch automatically when the active row changes. replace navigation keeps history clean;
  // manual switching goes through gotoRow (after follow=false this effect no longer jumps); "back to latest" sets it back to true to restore.
  useEffect(() => {
    if (!follow || !activeRow || activeRow.id === id) return;
    navigate(`/p/${projectId}/v/${versionId}/reports/${activeRow.id}`, { replace: true });
  }, [follow, activeRow, id, navigate, projectId, versionId]);

  // ←/→ switch rows; yield when the lightbox is open or focus is in an input
  useEffect(() => {
    if (batchRows.length <= 1) return;
    const onKey = (e: KeyboardEvent) => {
      if (zoomOpen) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (curRowIdx < 0) return;
      if (e.key === 'ArrowLeft' && curRowIdx > 0) { e.preventDefault(); gotoRow(batchRows[curRowIdx - 1]!.id); }
      else if (e.key === 'ArrowRight' && curRowIdx < batchRows.length - 1) { e.preventDefault(); gotoRow(batchRows[curRowIdx + 1]!.id); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [batchRows, curRowIdx, id, zoomOpen]);

  if (isError) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--muted-foreground)', fontSize: 13 }}>
        {t('common:loadFailed')}：{error?.message ?? t('common:unknownError')}
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--muted-foreground)' }}>
        <Icon name="loader" size={16} className="animate-spin" />
        <span style={{ marginLeft: 8 }}>{t('common:loading')}</span>
      </div>
    );
  }

  // Execution is async: while running the report page connects directly to the MJPEG live stream; when done, the report appears in place.
  // A dataset run shares one stream end to end (key=case:<caseId>): row 0's report finishes first but the run keeps going,
  // so the row 0 page keeps the picture until the whole run ends. When finished, the frame freezes on the last one + a "replay" button (recording replay).
  const isRunning = data.status === 'running';
  // In multi-row dataset runs, one stream is shared end to end (key=case:<caseId>): after a non-last row's report finishes, the run keeps going,
  // and the page keeps the picture until the whole run ends. The check uses "position within the batch" rather than datasetRowIndex===0 —
  // with partial row selection the first executed row's datasetRowIndex is not necessarily 0.
  const keepLiveForDataset =
    !!data.datasetBatchId && batchQuery.isSuccess && batchRows.length > 1 && curRowIdx < batchRows.length - 1;
  // Failure root cause analysis result (produced asynchronously by AI when the plan enables rcaEnabled; null when unanalyzed / old report)
  const rca = data.rca ?? null;

  // Case-level "execution start" has three states:
  //   has startedAt → display normally (true execution-phase start, same baseline as durationMs)
  //   running but no startedAt → still queued/preparing (worker not picked up or hung); fall back to createdAt, label becomes "requested at"
  //   not running and no startedAt → old report (field added later); the whole row is hidden
  const caseStartLabel = data.startedAt
    ? t('reports:meta.caseStartedAt')
    : isRunning ? t('reports:meta.queuedAt') : null;
  const caseStartValue = data.startedAt
    ? fullDateTime(data.startedAt)
    : isRunning ? fullDateTime(data.createdAt) : null;

  const stepResults = (data.stepResults as StepResult[]) ?? [];
  const passed = stepResults.filter((s) => s.status === 'passed').length;
  const failed = stepResults.filter((s) => s.status === 'failed').length;
  // AI call summary: full sum of step aiUsage + visionAssert.aiUsage
  const aiTotal = stepResults.reduce(
    (acc, s) => {
      for (const u of [s.aiUsage, s.visionAssert?.aiUsage]) {
        if (!u) continue;
        acc.calls += u.calls;
        acc.tokens += u.promptTokens + u.completionTokens;
        acc.prompt += u.promptTokens;
        acc.ms += u.modelCallMs;
        acc.cacheRead += u.cacheReadTokens ?? 0;
      }
      return acc;
    },
    { calls: 0, tokens: 0, prompt: 0, ms: 0, cacheRead: 0 },
  );
  // Cache hit rate: hits / (newly computed prompt + hits). Hidden when the denominator is 0 (old reports have no cache fields).
  const aiCacheRate =
    aiTotal.cacheRead + aiTotal.prompt > 0 ? Math.round((aiTotal.cacheRead / (aiTotal.cacheRead + aiTotal.prompt)) * 100) : null;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header bar */}
      <div className="flex items-center gap-3 px-6 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        {/* Plan run member report: back to the owning plan run detail; a normal report goes back to the report list */}
        {data.planRunId && data.planId ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(`/p/${projectId}/v/${versionId}/plans/${data.planId}/runs/${data.planRunId}`)}
          >
            <Icon name="chevronLeft" size={12} />
            {t('reports:backToPlanRun')}
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => navigate(`/p/${projectId}/v/${versionId}/reports`)}>
            <Icon name="chevronLeft" size={12} />
            {t('reports:backToList')}
          </Button>
        )}
        <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
        <h1 className="text-[16px] font-semibold" style={{ color: 'var(--foreground)' }}>
          {t('reports:reportTitle')}
        </h1>
        <StatusPill status={data.status}>{t(`cases:status.${data.status}`, { defaultValue: data.status })}</StatusPill>
        {data.healed && (
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-full"
            style={{ background: 'var(--warning-soft)', color: 'var(--warning)' }}
            title={t('reports:healedTooltip')}
          >
            {t('reports:healedPassed')}
          </span>
        )}
        {data.platform === 'mobile' && (
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-full"
            style={{ background: 'var(--info-soft)', color: 'var(--info)' }}
          >
            <Icon name="tablet" size={11} />
            {data.mobileOs ?? 'mobile'}{data.deviceName ? ` · ${data.deviceName}` : ''}
          </span>
        )}
        <Button
          variant="ghost"
          onClick={() => setShowDelete(true)}
          style={{ color: 'var(--destructive)' }}
          aria-label={t('reports:delete.title')}
          title={t('reports:delete.title')}
        >
          <Icon name="trash" size={12} />
        </Button>
        <div className="flex-1" />
        <span className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
          {fullDateTime(data.createdAt)} · {data.durationMs ?? 0} ms
        </span>
      </div>

      {/* Body — step timeline + metadata on the right. Screenshot and details merged into a single step list; each row shows duration / hit locator / tab / failure reason / thumbnail together. */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="flex gap-5 p-6">
          <div className="flex-1 min-w-0 flex flex-col gap-3">
            {/* Live picture while running | at the dataset tail; freezes when done + replay button */}
            <LiveViewCard
              liveUrl={api.cases.liveUrl(data.caseId)}
              replayUrl={(speed) => api.cases.replayUrl(data.caseId, speed)}
              replayMetaUrl={api.cases.replayMetaUrl(data.caseId)}
              running={isRunning || keepLiveForDataset}
            />
            {/* Dataset row switcher: row-number chips for the N rows of the batch (status dots converge via 2s polling);
                auto-follows the active row while running; clicking a chip/arrow key switches manually and pauses following, "back to latest" restores. */}
            {batchRows.length > 1 && (
              <div className="flex items-center gap-2 flex-wrap bg-card border rounded-[var(--radius-md)] px-4 py-2">
                <span className="text-[12px] font-medium shrink-0" style={{ color: 'var(--muted-foreground)' }}>
                  {t('reports:detail.datasetRows')}
                </span>
                <div className="flex items-center gap-1 flex-wrap">
                  {batchRows.map((r, i) => {
                    const cur = r.id === id;
                    const isActive = activeRow?.id === r.id;
                    const dotColor =
                      r.status === 'passed' ? 'var(--success)'
                      : r.status === 'failed' ? 'var(--destructive)'
                      : r.status === 'running' ? 'var(--primary)'
                      : 'var(--muted-foreground)';
                    const vars = r.datasetSnapshot
                      ? Object.entries(r.datasetSnapshot.values).map(([k, v]) => `${k}=${v}`).join(' · ')
                      : '';
                    // Chip number = dataset row number (enabled-row index + 1), stable across batches; not the position within the batch
                    const rowNo = r.datasetRowIndex != null ? r.datasetRowIndex + 1 : i + 1;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        className="rowchip"
                        style={cur ? { borderColor: 'var(--primary)', boxShadow: '0 0 0 2px var(--primary-soft)' } : undefined}
                        onClick={() => gotoRow(r.id)}
                        title={t('reports:detail.rowVarsTitle', { index: rowNo, vars })}
                      >
                        {rowNo}
                        <span
                          className={isActive ? 'status-pulse' : undefined}
                          style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor, flexShrink: 0 }}
                        />
                      </button>
                    );
                  })}
                </div>
                <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
                <Button variant="ghost" size="sm" disabled={curRowIdx <= 0} onClick={() => gotoRow(batchRows[curRowIdx - 1]!.id)}>
                  <Icon name="chevronLeft" size={12} />
                </Button>
                <Button variant="ghost" size="sm" disabled={curRowIdx < 0 || curRowIdx >= batchRows.length - 1} onClick={() => gotoRow(batchRows[curRowIdx + 1]!.id)}>
                  <Icon name="chevronRight" size={12} />
                </Button>
                <span className="text-[12px] font-medium" style={{ color: 'var(--muted-foreground)', fontVariantNumeric: 'tabular-nums' }}>
                  {curRowIdx + 1}/{batchRows.length}
                </span>
                <div className="flex-1" />
                {activeRow && (follow ? (
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
            )}
            {data.summary && (
              <div className="bg-card border rounded-[var(--radius-md)] p-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
                {data.summary}
              </div>
            )}
            {rca && (
              <div className="shrink-0 bg-card border rounded-[var(--radius-md)] p-4">
                <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-2" style={{ color: 'var(--muted-foreground)' }}>{t('reports:rca.title')}</div>
                <RcaBlock rca={rca} threadJump assistantPath={`/p/${projectId}/v/${versionId}/assistant`} />
              </div>
            )}
            <div className="bg-card border rounded-[var(--radius-md)] overflow-hidden">
              <div className="px-5 py-[10px] hairline-bottom" style={{ background: 'var(--muted)' }}>
                <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--muted-foreground)' }}>
                  {t('reports:detail.stepTimeline')}
                </span>
              </div>
              <ReportStepTimeline stepResults={stepResults} isRunning={isRunning} onZoomOpenChange={setZoomOpen} />
            </div>
          </div>

          {/* Right rail — statistics */}
          <div className="w-[280px] shrink-0 flex flex-col gap-3">
            <div className="bg-card border rounded-[var(--radius-md)] p-4">
              <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-3" style={{ color: 'var(--muted-foreground)' }}>
                {t('reports:detail.summaryTitle')}
              </div>
              <MetaRow label={t('reports:summary.totalSteps')} value={<span style={{ fontSize: 14, fontWeight: 600, color: 'var(--foreground)' }}>{stepResults.length}</span>} />
              <MetaRow label={t('cases:status.passed')} value={<span style={{ fontSize: 14, fontWeight: 600, color: 'var(--success)' }}>{passed}</span>} />
              <MetaRow label={t('cases:status.failed')} value={<span style={{ fontSize: 14, fontWeight: 600, color: 'var(--destructive)' }}>{failed}</span>} />
              {aiTotal.calls > 0 && (
                <MetaRow
                  label={t('reports:summary.aiCalls')}
                  value={<span className="font-mono text-[11px]">{t('reports:aiCallsSummary', { count: aiTotal.calls, tokens: fmtTokens(aiTotal.tokens), seconds: (aiTotal.ms / 1000).toFixed(1), cacheHitSuffix: aiCacheRate != null ? t('reports:aiCacheHit', { rate: aiCacheRate }) : '' })}</span>}
                />
              )}
            </div>
            <div className="bg-card border rounded-[var(--radius-md)] p-4">
              <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-3" style={{ color: 'var(--muted-foreground)' }}>
                {t('reports:detail.metadataTitle')}
              </div>
              <MetaRow
                label={t('reports:meta.caseName')}
                value={
                  data.caseTitle ? (
                    /* Case name jumps to the case detail: report and case are many-to-many, located by caseId */
                    <button
                      type="button"
                      onClick={() => navigate(`/p/${projectId}/v/${versionId}/cases/${data.caseId}`)}
                      className="underline-offset-2 hover:underline"
                      style={{ color: 'var(--primary)', cursor: 'pointer' }}
                      title={t('reports:detail.openCase')}
                    >
                      {data.caseTitle}
                    </button>
                  ) : (
                    <span style={{ color: 'var(--muted-foreground)' }}>{t('plans:deletedCase')}</span>
                  )
                }
              />
              <MetaRow label={t('reports:meta.caseId')} value={<span className="font-mono text-[11px]">{data.caseId.slice(0, 8)}</span>} />
              <MetaRow label={t('reports:meta.reportId')} value={<span className="font-mono text-[11px]">{data.id.slice(0, 8)}</span>} />
              {/* Execution start: true execution-phase moment (excluding queuing/environment resolution). The whole row is hidden when old reports lack this data. */}
              {caseStartValue && caseStartLabel && (
                <MetaRow label={caseStartLabel} value={<span className="font-mono text-[11px]">{caseStartValue}</span>} />
              )}
              {data.finishedAt && (
                <MetaRow label={t('reports:meta.caseFinishedAt')} value={<span className="font-mono text-[11px]">{fullDateTime(data.finishedAt)}</span>} />
              )}
              {data.createdBy && <MetaRow label={t('cases:createdBy')} value={<span>{creatorName(data.createdBy)}</span>} />}
              {data.platform && (
                <MetaRow label={t('reports:meta.platform')} value={data.platform} />
              )}
              {data.platform && (
                <MetaRow label={t('reports:meta.device')} value={`${data.mobileOs ?? data.platform}${data.deviceName ? ` · ${data.deviceName}` : ''}`} />
              )}
              {data.datasetRowIndex != null && data.datasetSnapshot && (
                <MetaRow label={t('reports:meta.dataRow')} value={`${data.datasetSnapshot.rowIndex + 1}/${data.datasetSnapshot.totalRows}`} />
              )}
            </div>
            {data.datasetSnapshot && (
              <div className="bg-card border rounded-[var(--radius-md)] p-4">
                <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-3" style={{ color: 'var(--muted-foreground)' }}>
                  {t('reports:detail.dataRowTitle')}
                </div>
                {Object.entries(data.datasetSnapshot.values).map(([k, v]) => (
                  <MetaRow key={k} label={k} value={<span className="font-mono text-[11px]">{v}</span>} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Delete confirm */}
      <Dialog open={showDelete} onOpenChange={setShowDelete}>
        <DialogContent style={{ maxWidth: 420 }}>
          <DialogHeader>
            <DialogTitle>{t('reports:delete.title')}</DialogTitle>
          </DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
            {t('reports:delete.confirm')}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowDelete(false)}>{t('common:cancel')}</Button>
            <Button
              variant="danger"
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
