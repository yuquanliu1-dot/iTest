import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { parseAsArrayOf, parseAsString, parseAsStringEnum, useQueryStates } from 'nuqs';
import { Search } from 'lucide-react';
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
import { DataTable, type DataTableColumn, type DataTableFacet } from '../components/ui/DataTable';
import { useTableSelection } from '../hooks/useTableSelection';
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

const VIEW_VALUES = ['card', 'table'] as const;
/** 计划运行状态域：running 初始 + passed/failed/cancelled 终态；'never' = 从未运行（本地派生值）。 */
const STATUS_FACET_VALUES = ['never', 'running', 'passed', 'failed', 'cancelled'] as const;

const plansParsers = {
  q: parseAsString.withDefault(''),
  page: parseAsString.withDefault('1'),
  pageSize: parseAsString.withDefault('20'),
  statuses: parseAsArrayOf(parseAsString).withDefault([]),
  creators: parseAsArrayOf(parseAsString).withDefault([]),
  view: parseAsStringEnum([...VIEW_VALUES]).withDefault('table'),
};

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
  // 筛选/分页/视图全走 URL（nuqs），与用例列表、执行历史一致
  const [raw, setRaw] = useQueryStates(plansParsers, { history: 'replace' });
  const view = raw.view as ViewMode;
  const page = Math.max(1, Number(raw.page) || 1);
  const pageSizeRaw = Number(raw.pageSize);
  const pageSize = [10, 20, 50, 100].includes(pageSizeRaw) ? pageSizeRaw : 20;
  const setSearch = (next: string) => void setRaw({ q: next, page: '1' });
  const setPage = (next: number) => void setRaw({ page: String(next) });
  const setPageSize = (next: number) => void setRaw({ pageSize: String(next), page: '1' });
  const setStatusFilter = (next: string[]) => void setRaw({ statuses: next, page: '1' });
  const setCreatorFilter = (next: string[]) => void setRaw({ creators: next, page: '1' });
  useEffect(() => {
    void setRaw({ page: '1' });
  }, [versionId]);

  // 按当前 versionId 过滤（NULL 版本 = 跨版本计划也展示，但用副标记）
  const versionPlans = useMemo(
    () => (plans ?? []).filter((p) => !versionId || p.versionId == null || p.versionId === versionId),
    [plans, versionId],
  );
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

  // 搜索（名称/版本/创建人，大小写不敏感）→ 状态/创建人 facet → 分页切片
  const statusOf = (p: PlanWithCount) => latestByPlan.get(p.id)?.status ?? 'never';
  const qLower = raw.q.trim().toLowerCase();
  const filteredPlans = useMemo(
    () =>
      versionPlans.filter((p) => {
        if (qLower) {
          const hit =
            p.name.toLowerCase().includes(qLower) ||
            (p.versionName ?? '').toLowerCase().includes(qLower) ||
            creatorName(p.createdBy).toLowerCase().includes(qLower);
          if (!hit) return false;
        }
        if (raw.statuses.length && !raw.statuses.includes(statusOf(p))) return false;
        if (raw.creators.length && !(p.createdBy && raw.creators.includes(p.createdBy.id))) return false;
        return true;
      }),
    [versionPlans, qLower, raw.statuses, raw.creators, latestByPlan],
  );
  const visiblePlans = filteredPlans.slice((page - 1) * pageSize, page * pageSize);

  const creatorOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of versionPlans) if (p.createdBy) m.set(p.createdBy.id, creatorName(p.createdBy));
    return [...m.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([value, label]) => ({ value, label }));
  }, [versionPlans]);

  const facets: DataTableFacet[] = [
    {
      id: 'status',
      label: t('plans:latestStatus'),
      options: STATUS_FACET_VALUES.map((s) => ({
        value: s,
        label: s === 'never' ? t('plans:statusNever') : t(`cases:status.${s}`),
      })),
    },
    {
      id: 'creator',
      label: t('plans:facetCreator'),
      options: creatorOptions,
    },
  ];

  // 批量选择（表格视图当前页行）
  const selection = useTableSelection(visiblePlans.map((p) => p.id));

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);

  const create = useMutation({
    mutationFn: () => api.projects.createPlan(projectId!, { name, versionId: versionId ?? undefined }),
    onSuccess: () => {
      setName('');
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
      qc.invalidateQueries({ queryKey: ['reports'] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const batchDeletePlans = useMutation({
    mutationFn: (planIds: string[]) => api.plans.removeBatch(planIds),
    onSuccess: (r) => {
      toast(t('plans:deletedPlansToast', { count: r.count }), 'success');
      setConfirmBatchDelete(false);
      selection.clear();
      qc.invalidateQueries({ queryKey: ['plans', projectId] });
      qc.invalidateQueries({ queryKey: ['executions'] });
      qc.invalidateQueries({ queryKey: ['reports'] });
    },
    onError: (e: Error) => {
      toast(localizeApiError(e), 'error');
      setConfirmBatchDelete(false);
    },
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
          <div className="relative w-48 sm:w-56">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              value={raw.q}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('plans:searchPlaceholder')}
              className="pl-7"
              size="sm"
            />
          </div>
          <Segmented<ViewMode>
            options={[
              { value: 'card', label: '', icon: 'grid', title: t('plans:cardView') },
              { value: 'table', label: '', icon: 'table', title: t('plans:tableView') },
            ]}
            value={view}
            onChange={(v) => void setRaw({ view: v })}
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
            {visiblePlans.length === 0 ? (
              <div className="flex items-center justify-center py-12 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
                {t('plans:noPlansOnPage')}
              </div>
            ) : (
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
            )}
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
              setFilter: (id, values) => {
                if (id === 'status') setStatusFilter(values);
                else if (id === 'creator') setCreatorFilter(values);
              },
              filters: {
                status: raw.statuses,
                creator: raw.creators,
              },
            }}
            columns={columnsDef}
            getRowId={(p) => p.id}
            rows={visiblePlans}
            total={filteredPlans.length}
            facets={facets}
            onRowClick={goPlanDetail}
            selection={{ state: selection, actions: (
              <>
                <Button size="sm" variant="destructive" onClick={() => setConfirmBatchDelete(true)}>
                  <Icon name="trash" size={12} />
                  {t('groups:batchDelete')}
                </Button>
              </>
            ) }}
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

      {/* 批量删除确认：运行历史与报告一并删除，与单删同语义 */}
      <Dialog open={confirmBatchDelete} onOpenChange={(open) => { if (!open) setConfirmBatchDelete(false); }}>
        <DialogContent style={{ maxWidth: 420 }}>
          <DialogHeader><DialogTitle>{t('plans:batchDeleteTitle')}</DialogTitle></DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
            {t('plans:batchDeleteConfirm', { count: selection.count })}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmBatchDelete(false)}>{t('common:cancel')}</Button>
            <Button
              variant="destructive"
              disabled={batchDeletePlans.isPending || selection.count === 0}
              onClick={() => batchDeletePlans.mutate(selection.ids)}
            >
              {batchDeletePlans.isPending ? t('cases:deleting') : t('plans:batchDeleteButton', { count: selection.count })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}