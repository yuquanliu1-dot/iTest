import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { localizeApiError } from '../../i18n';
import { api, type AssistantTrajectory } from '../../api/client';
import { useUIStore } from '../../stores/ui';
import Icon from '../Icon';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import EmptyState from '../ui/EmptyState';
import Pagination from '../ui/Pagination';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/Modal';

const PAGE_SIZE = 20;

/** Settings page "assistant trajectories": read-only list + soft delete (the only write entry point is the persistence hook → distillation worker). Server-side pagination. */
export default function TrajectoriesSection() {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [lineFilter, setLineFilter] = useState('all');
  // The product line dropdown's candidates come from the product line table (can't infer from loaded rows — after pagination only the current page's lines remain).
  const linesQ = useQuery({ queryKey: ['productLines'], queryFn: () => api.productLines.list(), staleTime: 60_000 });
  const lineOptions = useMemo(() => (linesQ.data ?? []).map((l) => [l.id, l.name] as const), [linesQ.data]);
  // If the filtered line is deleted, lineId no longer matches — clamp back to all to avoid a dangling select + a fake "no trajectories".
  const effectiveFilter = lineFilter !== 'all' && !lineOptions.some(([id]) => id === lineFilter) ? 'all' : lineFilter;
  // Default to active only: soft-deleted rows vanish from the UI (same scope as injection and retrieval); auditing goes through the API status parameter.
  // Line filtering is pushed down to the server so total count and list share the same scope.
  const listQ = useQuery({
    queryKey: ['assistant-trajectories', page, pageSize, effectiveFilter],
    queryFn: () => api.assistant.trajectories.list({
      status: 'active',
      page,
      limit: pageSize,
      ...(effectiveFilter === 'all' ? {} : { productLineId: effectiveFilter }),
    }),
  });
  const [detailing, setDetailing] = useState<AssistantTrajectory | null>(null);
  const [deleting, setDeleting] = useState<AssistantTrajectory | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => api.assistant.trajectories.remove(id),
    onSuccess: () => {
      toast(t('settings:saved'), 'success');
      setDeleting(null);
      qc.invalidateQueries({ queryKey: ['assistant-trajectories'] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const rows = listQ.data?.items ?? [];
  const total = listQ.data?.total ?? 0;
  // After deletion/filtering the current page may be out of bounds — clamp to the last page (judge only after data arrives, to avoid clamping mid-pagination).
  useEffect(() => {
    if (!listQ.data) return;
    const totalPages = Math.max(1, Math.ceil(listQ.data.total / pageSize));
    if (page > totalPages) setPage(totalPages);
  }, [listQ.data, page, pageSize]);

  return (
    <div className="bg-card border rounded-[var(--radius-sm)]">
      <div className="flex items-center gap-2 px-4 py-3 hairline-bottom" style={{ borderColor: 'var(--border)' }}>
        <Icon name="listChecks" size={14} style={{ color: 'var(--primary)' }} />
        <h3 className="text-[14px] font-semibold m-0 flex-1" style={{ color: 'var(--foreground)' }}>
          {t('settings:trajectoryTitle')}
        </h3>
        <select
          className="input-base"
          style={{ width: 'auto', fontSize: 12 }}
          aria-label={t('settings:trajectoryFilterAll')}
          value={effectiveFilter}
          onChange={(e) => { setLineFilter(e.target.value); setPage(1); }}
        >
          <option value="all">{t('settings:trajectoryFilterAll')}</option>
          {lineOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </div>
      <div className="px-4 pt-2 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
        {t('settings:trajectoryIntro')}
      </div>
      <div className="p-2">
        {listQ.isError ? (
          <div className="flex items-center gap-2 px-2 py-4 text-[12px]" style={{ color: 'var(--destructive)' }}>
            <Icon name="alertCircle" size={14} />
            {localizeApiError(listQ.error as Error)}
          </div>
        ) : listQ.isLoading ? (
          <div className="flex items-center gap-2 px-2 py-4 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
            <Icon name="loader" size={14} className="animate-spin" />
            {t('common:loading')}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon="listChecks" title={t('settings:trajectoryNone')} compact />
        ) : (
          rows.map((tr) => (
            <div key={tr.id} className="flex items-center gap-3 px-2 py-2">
              <div
                className="flex flex-col min-w-0 flex-1 cursor-pointer text-left"
                onClick={() => setDetailing(tr)}
                title={t('settings:trajectoryDetailTitle')}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-medium truncate" style={{ color: 'var(--foreground)' }}>{tr.taskTitle}</span>
                  <span className="text-[10px] px-1.5 py-[1px] rounded shrink-0" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}>
                    {tr.productLineName ?? '—'}
                  </span>
                </div>
                <span className="text-[11px] truncate" style={{ color: 'var(--muted-foreground)' }}>{tr.caseTitle}</span>
              </div>
              <span className="text-[11px] shrink-0" style={{ color: 'var(--muted-foreground)' }}>
                {t('settings:trajectoryHits', { count: tr.hitCount })}
              </span>
              <IconButton icon="eye" title={t('settings:trajectoryDetailTitle')} onClick={() => setDetailing(tr)} />
              <IconButton icon="trash" tone="destructive" title={t('common:delete')} onClick={() => setDeleting(tr)} />
            </div>
          ))
        )}
      </div>
      {total > 0 && (
        <div className="hairline-top" style={{ borderColor: 'var(--border)' }}>
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={setPage}
            onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
          />
        </div>
      )}

      <Dialog open={!!detailing} onOpenChange={(open) => { if (!open) setDetailing(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings:trajectoryDetailTitle')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[13px] font-semibold" style={{ color: 'var(--foreground)' }}>{detailing?.taskTitle}</span>
              <span className="text-[10px] px-1.5 py-[1px] rounded shrink-0" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}>
                {detailing?.productLineName ?? '—'}
              </span>
            </div>
            {detailing?.caseTitle ? (
              <div className="text-[12px] break-words" style={{ color: 'var(--muted-foreground)' }}>{detailing.caseTitle}</div>
            ) : null}
            <div className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              {t('settings:trajectoryHits', { count: detailing?.hitCount ?? 0 })}
              {' · '}
              {detailing?.updatedAt ? new Date(detailing.updatedAt).toLocaleString() : ''}
            </div>
            {detailing?.taskKeywords ? (
              <div className="min-w-0">
                <div className="text-[11px] font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>
                  {t('settings:trajectoryKeywords')}
                </div>
                <div className="text-[12px] break-words" style={{ color: 'var(--foreground)' }}>{detailing.taskKeywords}</div>
              </div>
            ) : null}
            <div className="min-w-0">
              <div className="text-[11px] font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>
                {t('settings:trajectoryDigest')}
              </div>
              <div
                className="text-[12px] whitespace-pre-wrap break-words max-h-[50vh] overflow-auto rounded border p-3"
                style={{ borderColor: 'var(--border)', color: 'var(--foreground)' }}
              >
                {detailing?.digest}
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 hairline-top" style={{ borderColor: 'var(--border)' }}>
            <Button variant="ghost" onClick={() => setDetailing(null)}>{t('common:close')}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleting} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings:trajectoryDeleteConfirm', { name: deleting?.taskTitle })}</DialogTitle>
          </DialogHeader>
          <div className="flex justify-end gap-2 px-5 py-4">
            <Button variant="ghost" onClick={() => setDeleting(null)}>{t('common:cancel')}</Button>
            <Button variant="danger" disabled={remove.isPending} onClick={() => deleting && remove.mutate(deleting.id)}>
              {t('common:delete')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
