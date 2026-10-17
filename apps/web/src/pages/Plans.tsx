import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { localizeApiError } from '../i18n';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type PlanWithCount } from '../api/client';
import { useProjectStore } from '../stores/project';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import EmptyState from '../components/ui/EmptyState';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import IconButton from '../components/ui/IconButton';
import Segmented from '../components/ui/Segmented';
import StatusPill from '../components/ui/StatusPill';
import { EmptyCellValue } from '../components/ui/Table';
import { DataTable, type DataTableColumn } from '../components/ui/DataTable';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/Modal';
import Pagination from '../components/ui/Pagination';
import { shortDateTime, fullDateTime } from '../lib/format';
import { creatorName } from '../lib/creatorName';
import {
  PageShell,
  PageShellActions,
  PageShellContent,
  PageShellDescription,
  PageShellHeader,
  PageShellTitle,
} from '../components/layout/PageShell';

type ViewMode = 'card' | 'table';

export default function Plans() {
  const { projectId, versionId } = useParams<{ projectId: string; versionId?: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const currentVersionName = useProjectStore((s) => s.current?.versionName ?? null);
  const { data: plans, isLoading, isError, error } = useQuery({
    queryKey: ['plans', projectId, versionId ?? 'all'],
    queryFn: () => api.projects.plans(projectId!),
    enabled: !!projectId,
  });
  // 按当前 versionId 过滤（NULL 版本 = 跨版本计划也展示，但用副标记）
  const filteredPlans = (plans ?? []).filter((p) => !versionId || p.versionId == null || p.versionId === versionId);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [view, setView] = useState<ViewMode>('table');
  useEffect(() => {
    setPage(1);
  }, [versionId]);
  const visiblePlans = filteredPlans.slice((page - 1) * pageSize, page * pageSize);
  const { data: planRuns } = useQuery({
    queryKey: ['executions', projectId, 'plan'],
    queryFn: () => api.executions.list({ projectId, kind: 'plan' }),
    enabled: !!projectId,
  });
  const latestByPlan = useMemo(() => {
    const m = new Map<string, { status: string; summary: string | null; createdAt: string }>();
    for (const r of planRuns ?? []) {
      if (r.kind !== 'plan') continue;
      if (!m.has(r.planId)) m.set(r.planId, { status: r.status, summary: r.summary, createdAt: r.createdAt });
    }
    return m;
  }, [planRuns]);

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);

  const create = useMutation({
    mutationFn: () => api.projects.createPlan(projectId!, { name, environment: environment || undefined, versionId: versionId ?? undefined }),
    onSuccess: () => {
      setName('');
      setEnvironment('');
      setShowCreate(false);
      toast(t('plans:createdToast'), 'success');
      qc.invalidateQueries({ queryKey: ['plans', projectId] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const runPlan = useMutation({
    mutationFn: (planId: string) => api.plans.run(planId),
    onSuccess: (r, planId) => {
      toast(t('plans:runStartedToast'), 'success');
      qc.invalidateQueries({ queryKey: ['executions'] });
      navigate(versionId ? `/p/${projectId}/v/${versionId}/plans/${planId}/runs/${r.runId}` : `/`);
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const deletePlan = useMutation({
    mutationFn: (id: string) => api.plans.remove(id),
    onSuccess: () => {
      toast(t('plans:deletedToast'), 'success');
      setConfirmDelete(null);
      qc.invalidateQueries({ queryKey: ['plans', projectId] });
      qc.invalidateQueries({ queryKey: ['executions'] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const goPlanDetail = (p: PlanWithCount) =>
    navigate(versionId ? `/p/${projectId}/v/${versionId}/plans/${p.id}` : `/`);

  const columnsDef: DataTableColumn<PlanWithCount>[] = [
    {
      id: 'name',
      header: t('plans:name'),
      cell: (p) => <span className="font-semibold truncate" title={p.name}>{p.name}</span>,
      cellClassName: 'min-w-0',
    },
    {
      id: 'environment',
      header: t('plans:environment'),
      width: 'w-[10%]',
      hideBelow: 'lg',
      cellClassName: 'text-muted-foreground',
      cell: (p) => <span className="truncate">{p.environment ?? <EmptyCellValue />}</span>,
    },
    {
      id: 'caseCount',
      header: t('plans:caseCount'),
      width: 'w-[8%]',
      align: 'right',
      cellClassName: 'text-xs text-muted-foreground tabular-nums',
      cell: (p) => <span>{p.caseCount}</span>,
    },
    {
      id: 'latestStatus',
      header: t('plans:latestStatus'),
      width: 'w-[110px]',
      cell: (p) => {
        const last = latestByPlan.get(p.id);
        return last ? <StatusPill status={last.status}>{t(`cases:status.${last.status}`)}</StatusPill> : <EmptyCellValue />;
      },
    },
    {
      id: 'latestRunAt',
      header: t('plans:latestRunAt'),
      width: 'w-[110px]',
      align: 'right',
      hideBelow: 'md',
      cellClassName: 'text-xs text-muted-foreground tabular-nums',
      cell: (p) => {
        const last = latestByPlan.get(p.id);
        return last ? <span title={fullDateTime(last.createdAt)}>{shortDateTime(last.createdAt)}</span> : <EmptyCellValue />;
      },
    },
    {
      id: 'createdBy',
      header: t('groups:createdBy'),
      width: 'w-[96px]',
      hideBelow: 'lg',
      cellClassName: 'text-xs text-muted-foreground',
      cell: (p) => (p.createdBy ? <span className="truncate">{creatorName(p.createdBy)}</span> : <EmptyCellValue />),
    },
    {
      id: 'createdAt',
      header: t('plans:createdAt'),
      width: 'w-[110px]',
      align: 'right',
      hideBelow: 'md',
      cellClassName: 'text-xs text-muted-foreground tabular-nums',
      cell: (p) => <span title={fullDateTime(p.createdAt)}>{shortDateTime(p.createdAt)}</span>,
    },
    {
      id: 'actions',
      header: '',
      width: 'w-[112px]',
      align: 'right',
      hideable: false,
      cell: (p) => (
        <span
          className="flex items-center justify-end gap-1"
          onClick={(e) => e.stopPropagation()}
        >
          <IconButton
            icon={runPlan.isPending && runPlan.variables === p.id ? 'loader' : 'play'}
            title={t('plans:run')}
            tone="accent"
            disabled={runPlan.isPending && runPlan.variables === p.id}
            onClick={() => runPlan.mutate(p.id)}
          />
          <IconButton
            icon="reportView"
            title={t('cases:viewReport')}
            onClick={() => navigate(versionId ? `/p/${projectId}/v/${versionId}/reports?planId=${p.id}&tab=plan` : `/`)}
          />
          <IconButton
            icon="trash"
            title={t('common:delete')}
            tone="destructive"
            onClick={() => setConfirmDelete({ id: p.id, name: p.name })}
          />
        </span>
      ),
    },
  ];

  return (
    <PageShell contained>
      <PageShellHeader>
        <PageShellTitle>{t('plans:title')}</PageShellTitle>
        <PageShellActions>
          <Segmented<ViewMode>
            options={[
              { value: 'card', label: '', icon: 'grid', title: t('plans:cardView') },
              { value: 'table', label: '', icon: 'table', title: t('plans:tableView') },
            ]}
            value={view}
            onChange={setView}
          />
          <Button onClick={() => setShowCreate(true)}>
            <Icon name="plus" size={14} />
            {t('plans:newPlan')}
          </Button>
        </PageShellActions>
        <PageShellDescription>
          {t('plans:newPlanHint')}
          {currentVersionName ? ` · ${currentVersionName}` : null}
        </PageShellDescription>
      </PageShellHeader>

      <PageShellContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-12" style={{ color: 'var(--muted-foreground)' }}>
            <Icon name="loader" size={16} className="animate-spin" />
            <span style={{ marginLeft: 8 }}>{t('cases:loading')}</span>
          </div>
        ) : isError ? (
          <div className="flex items-center justify-center py-12" style={{ color: 'var(--muted-foreground)', fontSize: 13 }}>
            {t('common:loadFailed')}：{error?.message ?? t('common:unknownError')}
          </div>
        ) : !plans || plans.length === 0 ? (
          <EmptyState
            icon="flag"
            title={t('plans:noPlans')}
            description={t('plans:noPlansHint')}
            action={<Button size="sm" onClick={() => setShowCreate(true)}>+ {t('plans:newPlan')}</Button>}
          />
        ) : view === 'card' ? (
          <>
            <div
              className="grid grid-cols-3 gap-4 content-start flex-1 min-h-0 overflow-y-auto"
              data-stagger
            >
              {visiblePlans.map((p) => (
                <div
                  key={p.id}
                  data-stagger-item
                  onClick={() => goPlanDetail(p)}
                  className="bg-card border rounded-[var(--radius-md)] p-4 cursor-pointer hover-card"
                >
                  <div className="flex items-center justify-between">
                    <div className="text-[14px] font-semibold truncate" style={{ color: 'var(--foreground)' }}>
                      {p.name}
                    </div>
                    <span className="text-[10px] uppercase font-semibold px-2 py-[2px] rounded-full" style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}>
                      {p.environment ?? t('plans:defaultEnvironment')}
                    </span>
                  </div>
                  <div className="text-[12px] mt-2" style={{ color: 'var(--muted-foreground)' }}>
                    {t('plans:caseCountLabel', { count: p.caseCount })}
                  </div>
                  <div className="text-[11px] mt-1" style={{ color: 'var(--muted-foreground)' }}>
                    {t('plans:createdAtFull', { time: fullDateTime(p.createdAt), creator: creatorName(p.createdBy) })}
                  </div>
                  {(() => {
                    const last = latestByPlan.get(p.id);
                    if (!last) return null;
                    return (
                      <div className="text-[11px] mt-1 flex items-center gap-2" style={{ color: 'var(--muted-foreground)' }}>
                        <StatusPill status={last.status}>{t(`cases:status.${last.status}`)}</StatusPill>
                        <span>{shortDateTime(last.createdAt)}</span>
                      </div>
                    );
                  })()}
                  <div className="mt-3 flex items-center justify-end" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="press inline-flex items-center gap-1 text-[12px] hover:underline"
                      style={{ color: 'var(--primary)' }}
                      onClick={() => navigate(versionId ? `/p/${projectId}/v/${versionId}/reports?planId=${p.id}&tab=plan` : `/`)}
                    >
                      <Icon name="reportView" size={12} />
                      {t('cases:viewReport')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4">
              <Pagination
                page={page}
                pageSize={pageSize}
                total={filteredPlans.length}
                onPageChange={setPage}
                onPageSizeChange={(size) => {
                  setPageSize(size);
                  setPage(1);
                }}
              />
            </div>
          </>
        ) : (
          <DataTable<PlanWithCount>
            query={{
              sort: '',
              dir: 'asc',
              page,
              pageSize,
              tab: 'all',
              tabId: null,
              toggleSort: () => {},
              setSort: () => {},
              setDir: () => {},
              setPage: (p) => setPage(p),
              setPageSize: (s) => setPageSize(s),
              setTab: () => {},
              setFilter: () => {},
              filters: {},
            }}
            columns={columnsDef}
            getRowId={(p) => p.id}
            rows={visiblePlans}
            total={filteredPlans.length}
            onRowClick={goPlanDetail}
            empty={
              <EmptyState icon="flag" title={t('plans:noPlansOnPage')} description={t('plans:noPlansOnPageHint')} />
            }
          />
        )}
      </PageShellContent>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('plans:newPlan')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <Input label={t('plans:name')} placeholder={t('plans:namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} />
            <Input label={t('plans:environmentOptional')} placeholder={t('plans:environmentPlaceholder')} value={environment} onChange={(e) => setEnvironment(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>{t('common:cancel')}</Button>
            <Button disabled={!name || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? t('groups:creating') : t('groups:create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!confirmDelete} onOpenChange={(open) => { if (!open) setConfirmDelete(null); }}>
        <DialogContent style={{ maxWidth: 420 }}>
          <DialogHeader><DialogTitle>{t('plans:deletePlanTitle')}</DialogTitle></DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
            {t('plans:deletePlanConfirm', { name: confirmDelete?.name })}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>{t('common:cancel')}</Button>
            <Button
              variant="destructive"
              disabled={deletePlan.isPending}
              onClick={() => confirmDelete && deletePlan.mutate(confirmDelete.id)}
            >
              {deletePlan.isPending ? t('cases:deleting') : t('cases:confirmDelete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}