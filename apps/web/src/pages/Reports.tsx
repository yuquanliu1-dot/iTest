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
import { EmptyCellValue } from '../components/ui/Table';
import { DataTable, type DataTableColumn, type DataTableFacet, type DataTableTabs } from '../components/ui/DataTable';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/Modal';
import { useTableSelection } from '../hooks/useTableSelection';
import { fullDateTime, shortDateTime, formatDuration } from '../lib/format';
import { creatorName } from '../lib/creatorName';
import { useUIStore } from '../stores/ui';
import {
	PageShell,
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
	// 单用例深链：来自 GroupsPage「查看报告」按钮 → 把 q 固定为标题词
	caseId: parseAsString.withDefault(''),
	// 单计划深链：来自 Plans「查看报告」按钮 → 把 tab 固定为 plan
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
	const page = Math.max(1, Number(raw.page) || 1);
	const pageSizeRaw = Number(raw.pageSize);
	const pageSize = [10, 20, 50, 100].includes(pageSizeRaw) ? pageSizeRaw : 20;
	/** 待确认删除的计划运行（行内删除入口）；null = 未打开确认弹窗。 */
	const [confirmDeleteRun, setConfirmDeleteRun] = useState<{ id: string; label: string } | null>(null);

	const { data, isLoading, isError, error } = useQuery({
		queryKey: ['executions', projectId, versionId, tab, raw.statuses, raw.versions, raw.q, raw.caseId, raw.planId],
		queryFn: () =>
			api.executions.list({
				projectId,
				kind: tab,
				statuses: raw.statuses.length ? raw.statuses : undefined,
				versionIds: raw.versions.length ? raw.versions : undefined,
				q: raw.q.trim() ? raw.q.trim() : undefined,
				caseId: raw.caseId || undefined,
				planId: raw.planId || undefined,
			}),
		enabled: !!projectId,
	});

	// 版本 facet 选项 = 项目全量版本，与 GroupsPage 一致
	const { data: projectVersionList } = useQuery({
		queryKey: ['versions', projectId],
		queryFn: () => api.versions.list(projectId!),
		enabled: !!projectId,
	});

	// caseId 深链的标题：chip 上要显示用例名（否则用户只看到一个裸 UUID，
	// 无从确认"正在看的是哪个用例"）。取不到就退回短 id，不阻塞列表渲染。
	const { data: deepLinkedCase } = useQuery({
		queryKey: ['case', raw.caseId],
		queryFn: () => api.cases.get(raw.caseId!),
		enabled: !!raw.caseId,
		retry: false,
	});

	// case / plan 行均参与勾选；提交时按行类型分流到不同接口
	const allRows = useMemo(() => data ?? [], [data]);
	// 服务端一次返回所有行；这里在客户端按 page/pageSize 切片（与 GroupsPage 一致）。
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
	// 清除用例深链时连带清掉 q —— 旧深链会把标题塞进 q，两者与 caseId 是 AND 关系，
	// 留着 q 会让"取消筛选"看起来没生效（搜索词仍在悄悄收窄结果）。
	const clearCaseFilter = () => void setRaw({ caseId: null, q: null, page: '1' });
	const clearPlanFilter = () => void setRaw({ planId: null, page: '1' });

	// 深链 chip：URL 里带了 caseId / planId 但页面上看不见的过滤器是最难查的一类问题——
	// 用户改搜索词命中 0 条，却不知道有个看不见的条件在夹着。
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
			<span className="font-mono opacity-90">{raw.planId.slice(0, 8)}</span>
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

	// 按行 kind 分桶后并行提交：case → /reports/batch-delete，plan → /plan-runs/batch-delete
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
				set.add(r.id);
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
			selection.clear();
			qc.invalidateQueries({ queryKey: ['executions'] });
			qc.invalidateQueries({ queryKey: ['reports'] });
			qc.invalidateQueries({ queryKey: ['stats', projectId] });
		},
		onError: (e: Error) => toast(localizeApiError(e), 'error'),
	});

	// 单条删除计划运行：连带成员报告一起删（后端语义），删完刷新执行历史与统计
	const deleteRun = useMutation({
		mutationFn: (id: string) => api.planRuns.remove(id),
		onSuccess: () => {
			toast(t('plans:runDeletedToast'), 'success');
			setConfirmDeleteRun(null);
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
		{
			id: 'version',
			label: t('reports:list.version'),
			options: (projectVersionList ?? []).map((v) => ({ value: v.id, label: v.name })),
		},
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
							<span className="font-mono text-muted-foreground">run {r.id.slice(0, 8)}</span>
						</span>
					);
				}
				return (
					<span className="flex items-center gap-2 min-w-0">
						<span className="truncate">{(r as { caseTitle: string | null }).caseTitle ?? t('plans:deletedCase')}</span>
						<span className="font-mono text-[11px] text-muted-foreground">case {(r as { caseId: string }).caseId.slice(0, 8)}</span>
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
				// 用例行 = vision 断言 reason / 失败步 error；计划行 = 运行结论（N 通过 / M 失败）。
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
			// 计划运行支持单条删除（连带成员报告）；单用例报告走「报告详情页」删除，
			// 这里不给行内入口，避免同一份数据两套删除语义。
			cell: (r) =>
				r.kind !== 'plan' ? null : (
					<span className="flex items-center justify-end" onClick={(e) => e.stopPropagation()}>
						<IconButton
							icon="trash"
							title={t('plans:deleteRunTitle')}
							tone="destructive"
							// 运行中禁止删除：执行器还在写成员表与报告表，删一半会留悬挂数据
							disabled={r.status === 'running'}
							onClick={() => setConfirmDeleteRun({ id: r.id, label: r.id.slice(0, 8) })}
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
							// 空态要说清"为什么空"。带 caseId 深链且停在单用例 tab 时，空列表最常见的
							// 原因是：该用例只作为计划成员跑过（这批报告被 case 分支的 not exists 排除，
							// 改从计划 tab 展示），而不是"这个用例从没执行过"。
							// 只在 case tab 上引导——「所有」tab 本就含计划运行，为空说明真的什么都没有，
							// 给一个跳去计划 tab 的按钮反而是死路。
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

			<Dialog open={!!confirmDeleteRun} onOpenChange={(o) => { if (!o) setConfirmDeleteRun(null); }}>
				<DialogContent style={{ maxWidth: 420 }}>
					<DialogHeader><DialogTitle>{t('plans:deleteRunTitle')}</DialogTitle></DialogHeader>
					<div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
						{t('plans:deleteRunConfirm', { id: confirmDeleteRun?.label })}
					</div>
					<DialogFooter>
						<Button variant="ghost" onClick={() => setConfirmDeleteRun(null)}>{t('common:cancel')}</Button>
						<Button
							variant="destructive"
							disabled={deleteRun.isPending}
							onClick={() => confirmDeleteRun && deleteRun.mutate(confirmDeleteRun.id)}
						>
							{deleteRun.isPending ? t('cases:deleting') : t('cases:confirmDelete')}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</PageShell>
	);
}
