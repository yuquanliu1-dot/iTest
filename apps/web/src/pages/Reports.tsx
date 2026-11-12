import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { localizeApiError } from '../i18n';
import { useNavigate, useParams } from 'react-router-dom';
import { parseAsArrayOf, parseAsString, parseAsStringEnum, useQueryStates } from 'nuqs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { api } from '../api/client';
import Icon from '../components/Icon';
import StatusPill from '../components/ui/StatusPill';
import EmptyState from '../components/ui/EmptyState';
import Input from '../components/ui/Input';
import Button from '../components/ui/Button';
import IconButton from '../components/ui/IconButton';
import Segmented from '../components/ui/Segmented';
import { EmptyCellValue } from '../components/ui/Table';
import { DataTable, type DataTableColumn, type DataTableFacet, type DataTableTabs } from '../components/ui/DataTable';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/Modal';
import { useTableSelection } from '../hooks/useTableSelection';
import { fullDateTime, shortDateTime, formatDuration } from '../lib/format';
import { creatorName } from '../lib/creatorName';
import { useUIStore } from '../stores/ui';
import {
	PageShell,
	PageShellActions,
	PageShellContent,
	PageShellDescription,
	PageShellHeader,
	PageShellTitle,
} from '../components/layout/PageShell';

type Tab = 'all' | 'case' | 'plan';

const TAB_VALUES = ['all', 'case', 'plan'] as const;

const executionsParsers = {
	q: parseAsString.withDefault(''),
	page: parseAsString.withDefault('1'),
	pageSize: parseAsString.withDefault('20'),
	statuses: parseAsArrayOf(parseAsString).withDefault([]),
	versions: parseAsArrayOf(parseAsString).withDefault([]),
	tab: parseAsStringEnum([...TAB_VALUES]).withDefault('all'),
	// Scope switch: current version / product line execution library (same as the case list page); shown only when the project hangs under a product line
	scope: parseAsStringEnum(['version', 'line']).withDefault('version'),
	// Single-case deep link: from the GroupsPage "view report" button → pins q to the title word
	caseId: parseAsString.withDefault(''),
	// Single-plan deep link: from the Plans "view report" button → pins tab to plan
	planId: parseAsString.withDefault(''),
};

export default function Executions() {
	const navigate = useNavigate();
	const { projectId, versionId: vidParam } = useParams<{ projectId: string; versionId?: string }>();
	const versionId = vidParam ?? null;
	const qc = useQueryClient();
	const toast = useUIStore((s) => s.showToast);
	const { t } = useTranslation();

	const [raw, setRaw] = useQueryStates(executionsParsers, { history: 'replace' });
	const tab = raw.tab as Tab;
	const scope = raw.scope;
	const onLineScope = scope === 'line';
	const page = Math.max(1, Number(raw.page) || 1);
	const pageSizeRaw = Number(raw.pageSize);
	const pageSize = [10, 20, 50, 100].includes(pageSizeRaw) ? pageSizeRaw : 20;
	/** Row pending delete confirmation (inline delete entry); null = confirm dialog not open. batchCount: number of reports a dataset batch row stands for. */
	const [confirmDelete, setConfirmDelete] = useState<{
		kind: 'case' | 'plan';
		id: string;
		label: string;
		batchCount?: number;
	} | null>(null);

	// Product line membership: when the project hangs under a product line, the header shows the "current version / product line execution library" scope switch
	const { data: scopeProject } = useQuery({
		queryKey: ['project', projectId],
		queryFn: () => api.projects.get(projectId!),
		enabled: !!projectId,
	});
	const productLineId = scopeProject?.productLineId ?? null;

	const { data, isLoading, isError, error } = useQuery({
		queryKey: ['executions', projectId, scope, productLineId, versionId, tab, raw.statuses, raw.versions, raw.q, raw.caseId, raw.planId],
		queryFn: () => {
			const base = {
				kind: tab,
				statuses: raw.statuses.length ? raw.statuses : undefined,
				q: raw.q.trim() ? raw.q.trim() : undefined,
				caseId: raw.caseId || undefined,
				planId: raw.planId || undefined,
			};
			// Product line execution library: fetch the whole line's execution history across projects (no projectId); before the line id loads, fetch by current version
			if (onLineScope && productLineId) {
				return api.executions.list({
					...base,
					productLineId,
					versionIds: raw.versions.length ? raw.versions : undefined,
				});
			}
			// The "current version" scope is always pinned to the current version (same convention as the case list page) — otherwise this returns the whole
			// project's execution history and the "current version" switch becomes a no-op.
			return api.executions.list({ ...base, projectId, versionIds: versionId ? [versionId] : undefined });
		},
		enabled: !!projectId,
	});

	// Line scope: the version facet switches to the whole line's version set
	const { data: lineVersionList } = useQuery({
		queryKey: ['versions', 'line', productLineId],
		queryFn: () => api.projects.versionsByProductLine(productLineId!),
		enabled: !!productLineId && onLineScope,
	});

	// Title for the caseId deep link: the chip must show the case name (otherwise the user sees only a bare UUID
	// and cannot tell "which case is being viewed"). Fall back to the short id when unavailable, without blocking list rendering.
	const { data: deepLinkedCase } = useQuery({
		queryKey: ['case', raw.caseId],
		queryFn: () => api.cases.get(raw.caseId!),
		enabled: !!raw.caseId,
		retry: false,
	});

	// Same for the planId deep link: the chip shows the plan name instead of a bare UUID (plan deleted → 404, fall back to the short id).
	const { data: deepLinkedPlan } = useQuery({
		queryKey: ['plan', raw.planId],
		queryFn: () => api.plans.get(raw.planId!),
		enabled: !!raw.planId,
		retry: false,
	});

	// Both case and plan rows participate in selection; on submit, rows are routed by kind to different endpoints
	const allRows = useMemo(() => data ?? [], [data]);
	// The server returns all rows at once; slicing by page/pageSize happens client-side here (consistent with GroupsPage).
	const rows = useMemo(
		() => allRows.slice((page - 1) * pageSize, page * pageSize),
		[allRows, page, pageSize],
	);
	const selectableIds = useMemo(() => allRows.map((r) => r.id), [allRows]);
	const selection = useTableSelection(selectableIds);

	const setPage = (next: number) => void setRaw({ page: String(next) });
	const setPageSize = (next: number) => void setRaw({ pageSize: String(next), page: '1' });
	const setStatusFilter = (next: string[]) => void setRaw({ statuses: next, page: '1' });
	const setVersionsFilter = (next: string[]) => void setRaw({ versions: next, page: '1' });
	const setSearch = (next: string) => void setRaw({ q: next, page: '1' });
	const setScope = (next: typeof scope) => void setRaw({ scope: next, page: '1' });
	// Clearing the case deep link also clears q — old deep links stuffed the title into q, and both AND with caseId;
	// keeping q makes "clear filter" look ineffective (the search term keeps quietly narrowing results).
	const clearCaseFilter = () => void setRaw({ caseId: null, q: null, page: '1' });
	const clearPlanFilter = () => void setRaw({ planId: null, page: '1' });

	// Deep link chip: filters present in the URL via caseId / planId but invisible on the page are the hardest class of bug to diagnose —
	// the user changes the search term, hits 0 rows, and does not know an invisible condition is interfering.
	const activeDeepLinkChip = raw.caseId ? (
		<span
			className="inline-flex max-w-[280px] items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
			style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}
		>
			<span className="shrink-0 opacity-80">{t('reports:list.filterCase')}</span>
			<span className="truncate" title={deepLinkedCase?.title ?? raw.caseId}>
				{deepLinkedCase?.title ?? raw.caseId.slice(0, 8)}
			</span>
			<button
				type="button"
				aria-label={t('reports:list.clearCaseFilter')}
				onClick={clearCaseFilter}
				className="shrink-0 opacity-70 hover:opacity-100"
			>
				<Icon name="close" size={10} />
			</button>
		</span>
	) : raw.planId ? (
		<span
			className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
			style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}
		>
			<span className="opacity-80">{t('reports:list.filterPlan')}</span>
			<span className="truncate opacity-90" title={deepLinkedPlan?.name ?? undefined}>{deepLinkedPlan?.name ?? raw.planId.slice(0, 8)}</span>
			<button
				type="button"
				aria-label={t('reports:list.clearPlanFilter')}
				onClick={clearPlanFilter}
				className="shrink-0 opacity-70 hover:opacity-100"
			>
				<Icon name="close" size={10} />
			</button>
		</span>
	) : null;

	// Bucket by row kind then submit in parallel: case → /reports/batch-delete, plan → /plan-runs/batch-delete
	// A single dataset batch record stands for N reports: checking one deletes the whole batch (memberReportIds expanded).
	const batchDeleteReports = useMutation({
		mutationFn: async (ids: string[]) => {
			const idByKind = new Map<string, Set<string>>();
			for (const r of allRows) {
				if (!ids.includes(r.id)) continue;
				let set = idByKind.get(r.kind);
				if (!set) {
					set = new Set<string>();
					idByKind.set(r.kind, set);
				}
				const members = (r as { memberReportIds?: string[] }).memberReportIds;
				if (members?.length) for (const m of members) set.add(m);
				else set.add(r.id);
			}
			const results: { kind: 'case' | 'plan'; count: number }[] = [];
			if (idByKind.get('case')?.size) {
				const r = await api.reports.removeBatch([...idByKind.get('case')!]);
				results.push({ kind: 'case', count: r.count });
			}
			if (idByKind.get('plan')?.size) {
				const r = await api.planRuns.removeBatch([...idByKind.get('plan')!]);
				results.push({ kind: 'plan', count: r.count });
			}
			return results;
		},
		onSuccess: (results) => {
			const total = results.reduce((sum, r) => sum + r.count, 0);
			const parts = results
				.map((r) => `${t(r.kind === 'plan' ? 'plans:planRunTitle' : 'reports:report')} ${r.count}`)
				.join(t('reports:list.listSeparator'));
			toast(t('reports:list.deletedToast', { count: total, parts }), 'success');
			setConfirmDelete(null);
			selection.clear();
			qc.invalidateQueries({ queryKey: ['executions'] });
			qc.invalidateQueries({ queryKey: ['reports'] });
			qc.invalidateQueries({ queryKey: ['stats', projectId] });
		},
		onError: (e: Error) => toast(localizeApiError(e), 'error'),
	});

	// Single delete of a plan run: member reports are deleted along with it (backend semantics); execution history and stats refresh afterwards
	const deleteRun = useMutation({
		mutationFn: (id: string) => api.planRuns.remove(id),
		onSuccess: () => {
			toast(t('plans:runDeletedToast'), 'success');
			setConfirmDelete(null);
			// Single delete after row selection: without clearing, the deleted id stays in selection and the bulk bar keeps showing a stale check
			selection.clear();
			qc.invalidateQueries({ queryKey: ['executions'] });
			qc.invalidateQueries({ queryKey: ['reports'] });
			qc.invalidateQueries({ queryKey: ['stats', projectId] });
		},
		onError: (e: Error) => toast(localizeApiError(e), 'error'),
	});

	const tabs: DataTableTabs = {
		id: 'tab',
		allLabel: t('reports:list.tabsAll'),
		options: [
			{ value: 'case', label: t('reports:list.tabsCase') },
			{ value: 'plan', label: t('plans:planRunTitle') },
		],
	};

	const facets: DataTableFacet[] = [
		{
			id: 'status',
			label: t('reports:list.status'),
			options: [
				{ value: 'passed', label: t('cases:status.passed') },
				{ value: 'failed', label: t('cases:status.failed') },
				{ value: 'running', label: t('reports:list.statusRunning') },
			],
		},
		// The "current version" scope is always pinned to the version, making this dimension meaningless; only line scope is used to pick baselines across versions
		...(onLineScope
			? [{
				id: 'version',
				label: t('reports:list.version'),
				options: (lineVersionList ?? []).map((v) => ({ value: v.id, label: v.name })),
			} as DataTableFacet]
			: []),
	];

	const columnsDef: DataTableColumn<(typeof rows)[number]>[] = [
		{
			id: 'kind',
			header: t('reports:list.columnKind'),
			width: 'w-[88px]',
			cellClassName: 'text-muted-foreground',
			cell: (r) => (r.kind === 'plan' ? t('reports:list.kindPlan') : t('reports:list.kindCase')),
		},
		{
			id: 'title',
			header: t('reports:list.columnTitle'),
			cell: (r) => {
				if (r.kind === 'plan') {
					return (
						<span className="flex items-center gap-2 min-w-0">
							<span className="truncate">{(r as { planName?: string | null }).planName ?? `run ${r.id.slice(0, 8)}`}</span>
						</span>
					);
				}
				const batchSize = (r as { batchSize?: number }).batchSize ?? 1;
				return (
					<span className="flex items-center gap-2 min-w-0">
						<span className="truncate">{(r as { caseTitle: string | null }).caseTitle ?? t('plans:deletedCase')}</span>
						<span className="font-mono text-[11px] text-muted-foreground">case {(r as { caseId: string }).caseId.slice(0, 8)}</span>
						{batchSize > 1 && (
							<span
								className="shrink-0 px-1.5 py-px text-[10px] rounded-full"
								style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}
								title={t('reports:list.batchRowsTitle', { count: batchSize })}
							>
								{t('reports:list.batchRowsBadge', { count: batchSize })}
							</span>
						)}
					</span>
				);
			},
			cellClassName: 'min-w-0',
		},
		{
			id: 'version',
			header: t('reports:list.version'),
			width: 'w-[140px]',
			hideBelow: 'md',
			cellClassName: 'text-xs text-muted-foreground',
			cell: (r) => (
				<span title={(r as { versionName?: string | null }).versionName ?? undefined}>
					{(r as { versionName?: string | null }).versionName ?? <EmptyCellValue />}
				</span>
			),
		},
		{
			id: 'status',
			header: t('reports:list.status'),
			width: 'w-[120px]',
			cell: (r) => (
				<span className="inline-flex items-center gap-1.5">
					<StatusPill status={r.status}>{t(`cases:status.${r.status}`, { defaultValue: r.status })}</StatusPill>
					{r.kind === 'case' && r.status === 'passed' && (r as { healed?: boolean }).healed && (
						<span
							className="px-1.5 py-px text-[10px] rounded-full"
							style={{ background: 'var(--warning-soft)', color: 'var(--warning)' }}
							title={t('reports:healedTooltip')}
						>
							{t('reports:healedBadge')}
						</span>
					)}
				</span>
			),
		},
		{
			id: 'assertion',
			header: t('reports:list.columnLastAssertion'),
			width: 'w-[240px]',
			hideBelow: 'lg',
			cellClassName: 'text-xs text-muted-foreground',
			cell: (r) => {
				// Case row = vision assertion reason / failed step error; plan row = run conclusion (N passed / M failed).
				// Dataset batch (one record stands for N rows) = within-batch passed / failed counts (a single-row assertion is meaningless for the whole batch).
				const batchSize = (r as { batchSize?: number }).batchSize ?? 1;
				if (r.kind === 'case' && batchSize > 1) {
					const passed = (r as { batchPassed?: number }).batchPassed ?? 0;
					const failed = (r as { batchFailed?: number }).batchFailed ?? 0;
					const text = t('reports:list.batchSummary', { passed, failed });
					return (
						<span className="block truncate" title={text}>
							{text}
						</span>
					);
				}
				const text = r.kind === 'case' ? (r.lastAssertion ?? null) : r.summary;
				if (!text) return <EmptyCellValue />;
				return (
					<span className="block truncate" title={text}>
						{text}
					</span>
				);
			},
		},
		{
			id: 'duration',
			header: t('reports:list.columnDuration'),
			width: 'w-[88px]',
			hideBelow: 'md',
			align: 'right',
			cellClassName: 'text-xs text-muted-foreground tabular-nums',
			cell: (r) => {
				const ms = (r as { durationMs?: number | null }).durationMs;
				const formatted = formatDuration(ms ?? null);
				return <span title={ms != null ? `${ms} ms` : undefined}>{formatted}</span>;
			},
		},
		{
			id: 'createdBy',
			header: t('reports:list.columnCreatedBy'),
			width: 'w-[96px]',
			hideBelow: 'lg',
			cellClassName: 'text-xs text-muted-foreground',
			cell: (r) => (r.createdBy ? <span className="truncate">{creatorName(r.createdBy)}</span> : <EmptyCellValue />),
		},
		{
			id: 'createdAt',
			header: t('reports:list.columnCreatedAt'),
			width: 'w-[110px]',
			align: 'right',
			cellClassName: 'text-xs text-muted-foreground tabular-nums',
			cell: (r) => <span title={fullDateTime(r.createdAt)}>{shortDateTime(r.createdAt)}</span>,
		},
		{
			id: 'actions',
			header: '',
			width: 'w-[44px]',
			align: 'right',
			hideable: false,
			// Inline delete: plan runs delete member reports along; case reports (including dataset batches, row count explained in the confirm dialog)
			// reuse the batch delete endpoint, same semantics as selection delete.
			cell: (r) => (
				<span className="flex items-center justify-end" onClick={(e) => e.stopPropagation()}>
					<IconButton
						icon="trash"
						title={r.kind === 'plan' ? t('plans:deleteRunTitle') : t('reports:delete.title')}
						tone="destructive"
						// No delete while running: the executor is still writing the member and report tables; deleting halfway leaves dangling data
						disabled={r.status === 'running'}
						onClick={() => {
							const batchSize = (r as { batchSize?: number }).batchSize ?? 1;
							setConfirmDelete({
								kind: r.kind,
								id: r.id,
								label:
									r.kind === 'plan'
										? r.id.slice(0, 8)
										: (r as { caseTitle?: string | null }).caseTitle ?? r.id.slice(0, 8),
								batchCount: r.kind === 'case' && batchSize > 1 ? batchSize : undefined,
							});
						}}
					/>
				</span>
			),
		},
	];

	const goRunDetail = (r: (typeof rows)[number]) =>
		navigate(
			r.kind === 'plan'
				? `/p/${projectId}/v/${versionId}/plans/${(r as { planId: string }).planId}/runs/${r.id}`
				: `/p/${projectId}/v/${versionId}/reports/${r.id}`,
		);

	const isEmpty = rows.length === 0;

	return (
		<PageShell contained className="gap-3">
			<PageShellHeader>
				<PageShellTitle>{t('common:navReports')}</PageShellTitle>
				<PageShellDescription>{t('reports:pageDesc')}</PageShellDescription>
				{productLineId && (
					<PageShellActions>
						<Segmented
							options={[
								{ value: 'version', label: t('reports:list.scopeVersion'), icon: 'tag' },
								{ value: 'line', label: t('reports:list.scopeProductLine'), icon: 'layers' },
							]}
							value={scope}
							onChange={(v) => setScope(v)}
						/>
					</PageShellActions>
				)}
			</PageShellHeader>

			<PageShellContent>
				{isError ? (
					<div className="flex flex-1 items-center justify-center text-muted-foreground text-xs">
						{t('common:loadFailed')}：{error?.message ?? t('common:unknownError')}
					</div>
				) : (
					<DataTable<(typeof rows)[number]>
						query={{
							sort: '',
							dir: 'asc',
							page,
							pageSize,
							tab,
							tabId: 'tab',
							toggleSort: () => {},
							setSort: () => {},
							setDir: () => {},
							setPage: (p) => setPage(p),
							setPageSize: (s) => setPageSize(s),
							setTab: (v) => void setRaw({ tab: (v === 'case' || v === 'plan' ? v : 'all') as Tab }),
							setFilter: (id, values) => {
								if (id === 'status') setStatusFilter(values);
								else if (id === 'version') setVersionsFilter(values);
							},
							filters: {
								status: raw.statuses,
								version: raw.versions,
							},
						}}
						columns={columnsDef}
						getRowId={(r) => r.id}
						rows={rows}
						total={allRows.length}
						loading={isLoading}
						facets={facets}
						tabs={tabs}
						leadingActions={activeDeepLinkChip}
						onRowClick={goRunDetail}
						selection={{
							state: selection,
							rowLabel: (r) => (r.kind === 'case' ? (r as { caseTitle?: string }).caseTitle ?? r.id : r.id),
							actions: (
								<Button
									size="sm"
									variant="destructive"
									onClick={() => batchDeleteReports.mutate(selection.ids)}
									disabled={batchDeleteReports.isPending || selection.count === 0}
								>
									<Icon name="trash" size={12} />
									{t('reports:list.batchDelete')}
								</Button>
							),
						}}
						search={(
							<div className="relative w-full sm:max-w-xs">
								<Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
								<Input
									value={raw.q}
									onChange={(e) => setSearch(e.target.value)}
									placeholder={t('reports:list.searchPlaceholder')}
									className="pl-7"
									size="sm"
								/>
							</div>
						)}
						empty={
							// The empty state must explain "why it is empty". With a caseId deep link while on the case tab, the most common
							// cause is: that case only ever ran as a plan member (those reports are excluded by the case branch's not exists
							// and shown under the plan tab instead), not "this case never ran".
							// Guide only on the case tab — the "all" tab already includes plan runs, so being empty there means truly nothing exists;
							// a button jumping to the plan tab would be a dead end.
							raw.caseId && tab === 'case' ? (
								<EmptyState
									icon="flag"
									title={t('reports:list.emptyFilteredTitle')}
									description={t('reports:list.emptyFilteredDesc')}
									action={
										<Button size="sm" onClick={() => void setRaw({ tab: 'plan', page: '1' })}>
											{t('reports:list.viewInPlanRuns')}
										</Button>
									}
								/>
							) : (
								<EmptyState icon="flag" title={t('reports:list.emptyTitle')} description={t('reports:list.emptyDesc')} />
							)
						}
					/>
				)}
			</PageShellContent>

			<Dialog open={!!confirmDelete} onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}>
				<DialogContent style={{ maxWidth: 420 }}>
					<DialogHeader>
						<DialogTitle>{confirmDelete?.kind === 'case' ? t('reports:delete.title') : t('plans:deleteRunTitle')}</DialogTitle>
					</DialogHeader>
					<div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
						{confirmDelete?.kind === 'case'
							? confirmDelete.batchCount
								? t('reports:delete.confirmBatch', { count: confirmDelete.batchCount })
								: t('reports:delete.confirm')
							: t('plans:deleteRunConfirm', { id: confirmDelete?.label })}
					</div>
					<DialogFooter>
						<Button variant="ghost" onClick={() => setConfirmDelete(null)}>{t('common:cancel')}</Button>
						<Button
							variant="destructive"
							disabled={deleteRun.isPending || batchDeleteReports.isPending}
							onClick={() => {
								if (!confirmDelete) return;
								if (confirmDelete.kind === 'case') batchDeleteReports.mutate([confirmDelete.id]);
								else deleteRun.mutate(confirmDelete.id);
							}}
						>
							{deleteRun.isPending || batchDeleteReports.isPending ? t('cases:deleting') : t('cases:confirmDelete')}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</PageShell>
	);
}
