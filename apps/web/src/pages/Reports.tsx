import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { parseAsString, parseAsStringEnum, useQueryStates } from 'nuqs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { api } from '../api/client';
import Icon from '../components/Icon';
import StatusPill from '../components/ui/StatusPill';
import EmptyState from '../components/ui/EmptyState';
import Input from '../components/ui/Input';
import Button from '../components/ui/Button';
import { EmptyCellValue } from '../components/ui/Table';
import { DataTable, type DataTableColumn, type DataTableTabs } from '../components/ui/DataTable';
import { useTableSelection } from '../hooks/useTableSelection';
import { fullDateTime, shortDateTime, formatDuration } from '../lib/format';
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
	q: parseAsStringEnum([...TAB_VALUES]).withDefault('all'),
	page: parseAsString.withDefault('1'),
	pageSize: parseAsString.withDefault('20'),
};

export default function Executions() {
	const navigate = useNavigate();
	const { projectId, versionId: vidParam } = useParams<{ projectId: string; versionId?: string }>();
	const versionId = vidParam ?? null;
	const qc = useQueryClient();
	const toast = useUIStore((s) => s.showToast);

	const [raw, setRaw] = useQueryStates(executionsParsers, { history: 'replace' });
	const tab = raw.q as Tab;
	const page = Math.max(1, Number(raw.page) || 1);
	const pageSizeRaw = Number(raw.pageSize);
	const pageSize = [10, 20, 50, 100].includes(pageSizeRaw) ? pageSizeRaw : 20;

	const { data, isLoading, isError, error } = useQuery({
		queryKey: ['executions', projectId, versionId, tab],
		queryFn: () => api.executions.list({ projectId, kind: tab }),
		enabled: !!projectId,
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
			const parts = results.map((r) => `${r.kind === 'plan' ? '计划运行' : '报告'} ${r.count}`).join('，');
			toast(`已删除 ${total} 条（${parts}）`, 'success');
			selection.clear();
			qc.invalidateQueries({ queryKey: ['executions'] });
			qc.invalidateQueries({ queryKey: ['reports'] });
			qc.invalidateQueries({ queryKey: ['stats', projectId] });
		},
		onError: (e: Error) => toast(e.message, 'error'),
	});

	const tabs: DataTableTabs = {
		id: 'q',
		allLabel: '所有',
		options: [
			{ value: 'case', label: '单用例' },
			{ value: 'plan', label: '计划运行' },
		],
	};

	const columnsDef: DataTableColumn<(typeof rows)[number]>[] = [
		{
			id: 'kind',
			header: '类型',
			width: 'w-[88px]',
			cellClassName: 'text-muted-foreground',
			cell: (r) => (r.kind === 'plan' ? '计划' : '用例'),
		},
		{
			id: 'title',
			header: '标识',
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
						<span className="truncate">{(r as { caseTitle: string | null }).caseTitle ?? '已删除用例'}</span>
						<span className="font-mono text-[11px] text-muted-foreground">case {(r as { caseId: string }).caseId.slice(0, 8)}</span>
					</span>
				);
			},
			cellClassName: 'min-w-0',
		},
		{
			id: 'version',
			header: '版本',
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
			header: '状态',
			width: 'w-[120px]',
			cell: (r) => <StatusPill status={r.status}>{r.status}</StatusPill>,
		},
		{
			id: 'duration',
			header: '耗时',
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
			id: 'createdAt',
			header: '时间',
			width: 'w-[110px]',
			align: 'right',
			cellClassName: 'text-xs text-muted-foreground tabular-nums',
			cell: (r) => (
				<span title={fullDateTime(r.createdAt)}>{shortDateTime(r.createdAt)}</span>
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
				<PageShellTitle>执行历史</PageShellTitle>
				<PageShellDescription>用例执行结果与计划运行汇总</PageShellDescription>
			</PageShellHeader>

			<PageShellContent>
				{isError ? (
					<div className="flex flex-1 items-center justify-center text-muted-foreground text-xs">
						加载失败：{error?.message ?? '未知错误'}
					</div>
				) : (
					<DataTable<(typeof rows)[number]>
						query={{
							sort: '',
							dir: 'asc',
							page,
							pageSize,
							tab,
							tabId: 'q',
							toggleSort: () => {},
							setSort: () => {},
							setDir: () => {},
							setPage: (p) => setPage(p),
							setPageSize: (s) => setPageSize(s),
							setTab: (v) => void setRaw({ q: (v === 'case' || v === 'plan' ? v : 'all') as Tab }),
							setFilter: () => {},
							filters: {},
						}}
						columns={columnsDef}
						getRowId={(r) => r.id}
						rows={rows}
						total={allRows.length}
						loading={isLoading}
						tabs={tabs}
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
									批量删除
								</Button>
							),
						}}
						search={(
							<div className="relative w-full sm:max-w-xs">
								<Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
								<Input placeholder="（预留搜索）" className="pl-7" size="sm" disabled />
							</div>
						)}
						empty={
							<EmptyState icon="flag" title="还没有执行记录" description="在执行计划或用例详情页运行测试后会出现在这里。" />
						}
					/>
				)}
			</PageShellContent>
		</PageShell>
	);
}