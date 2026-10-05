import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
	parseAsArrayOf,
	parseAsString,
	parseAsStringEnum,
	useQueryStates,
} from 'nuqs';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { api, type CaseStatus, type TestCase } from '../api/client';
import { useProjectStore } from '../stores/project';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import CaseStatusMenu from '../components/CaseStatusMenu';
import PriorityBadge from '../components/ui/PriorityBadge';
import EmptyState from '../components/ui/EmptyState';
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '../components/ui/Modal';
import Input from '../components/ui/Input';
import Button from '../components/ui/Button';
import Segmented from '../components/ui/Segmented';
import TagChip from '../components/ui/Tag';
import IconButton from '../components/ui/IconButton';
import { EmptyCellValue } from '../components/ui/Table';
import { DataTable, type DataTableColumn, type DataTableFacet, type DataTableTabs } from '../components/ui/DataTable';
import { useTableSelection } from '../hooks/useTableSelection';
import { caseStatusLabel, shortDateTime } from '../lib/format';
import {
	PageShell,
	PageShellActions,
	PageShellContent,
	PageShellDescription,
	PageShellHeader,
	PageShellTitle,
} from '../components/layout/PageShell';

const MAX_TAG_CHIPS = 3;

const STATUS_FILTER_VALUES = ['', 'draft', 'review', 'ready', 'deprecated'] as const;
const TAB_VALUES = ['all', 'draft', 'review', 'ready', 'deprecated'] as const;
const PRIORITY_VALUES = ['', 'P0', 'P1', 'P2', 'P3'] as const;

const caseParsers = {
	q: parseAsString.withDefault(''),
	page: parseAsString.withDefault('1'),
	pageSize: parseAsString.withDefault('20'),
	priority: parseAsStringEnum([...PRIORITY_VALUES]).withDefault(''),
	scenario: parseAsString.withDefault(''),
	status: parseAsArrayOf(parseAsString).withDefault([]),
	tag: parseAsArrayOf(parseAsString).withDefault([]),
	tab: parseAsStringEnum([...TAB_VALUES]).withDefault('all'),
};

type GroupForm = { open: boolean; mode: 'create' | 'edit'; id: string | null; name: string; defaultUrl: string };
const EMPTY_GROUP_FORM: GroupForm = { open: false, mode: 'create', id: null, name: '', defaultUrl: '' };
type AiForm = { open: boolean; title: string; content: string; coverage: string[] };
/** 覆盖类型多选：勾选 = 必须覆盖，拼入首条用户消息；未勾选不禁止（AI 自行判断）。 */
const COVERAGE_TYPES = [
	{ key: 'functional', label: '功能（正常流）' },
	{ key: 'exception', label: '异常场景' },
	{ key: 'boundary', label: '边界值' },
	{ key: 'security', label: '安全（SQL 注入·XSS·越权·未授权等）' },
	{ key: 'uiux', label: 'UI/UX（呈现·交互）' },
] as const;
const DEFAULT_COVERAGE = ['functional', 'exception'];
const EMPTY_AI_FORM: AiForm = { open: false, title: '', content: '', coverage: DEFAULT_COVERAGE };

/** 勾选项 → 首条消息尾部的覆盖要求块；全不勾 = 不加约束（返回空串）。 */
function coveragePrompt(keys: string[]): string {
	const labels = COVERAGE_TYPES.filter((t) => keys.includes(t.key)).map((t) => t.label);
	if (labels.length === 0) return '';
	return `\n\n【覆盖要求】本次生成必须覆盖以下测试类型：${labels.join('、')}；每类至少 1 条用例，未列出的类型自行判断。`;
}
type CasePriority = 'P0' | 'P1' | 'P2' | 'P3';
type CaseForm = { open: boolean; title: string; groupId: string; priority: CasePriority; url: string; description: string };
const EMPTY_CASE_FORM: CaseForm = { open: false, title: '', groupId: '', priority: 'P1', url: '', description: '' };

export default function GroupsPage() {
	const { projectId, groupId, versionId: vidParam } = useParams<{ projectId: string; groupId: string; versionId: string }>();
	const versionId = vidParam ?? null;
	const navigate = useNavigate();
	const toast = useUIStore((s) => s.showToast);
	const qc = useQueryClient();
	const current = useProjectStore((s) => s.current);

	const [raw, setRaw] = useQueryStates(caseParsers, { history: 'replace' });
	const q = raw.q;
	const priority = raw.priority;
	const scenarioId = raw.scenario;
	const statusSelected = raw.status;
	const tagSelected = raw.tag;
	const tab = raw.tab;
	const page = Math.max(1, Number(raw.page) || 1);
	const pageSizeRaw = Number(raw.pageSize);
	const pageSize = [10, 20, 50, 100].includes(pageSizeRaw) ? pageSizeRaw : 20;
	const [groupForm, setGroupForm] = useState<GroupForm>(EMPTY_GROUP_FORM);
	const [confirmDeleteGroup, setConfirmDeleteGroup] = useState<{ id: string; name: string } | null>(null);
	const [copyModal, setCopyModal] = useState<{ caseIds: string[] } | null>(null);
	const [planModal, setPlanModal] = useState<{ caseIds: string[] } | null>(null);
	const [copyTarget, setCopyTarget] = useState('');
	const [planTarget, setPlanTarget] = useState('');
	const [confirmDeleteCase, setConfirmDeleteCase] = useState<{ id: string; title: string } | null>(null);
	const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
	const [aiForm, setAiForm] = useState<AiForm>(EMPTY_AI_FORM);
	const [caseForm, setCaseForm] = useState<CaseForm>(EMPTY_CASE_FORM);

	const { data: groups, isLoading: groupsLoading } = useQuery({
		queryKey: ['groups', projectId],
		queryFn: () => api.projects.groups(projectId!),
		enabled: !!projectId,
	});

	const effectiveGroupId = groupId ?? '';
	// 拉列表时只透传后端支持的过滤（priority/scenarioId），status/tags 走前端本地筛（API 暂不接）。
	const { data: cases, isLoading: casesLoading, isError: casesError, error: casesErrorObj } = useQuery({
		queryKey: ['cases', projectId, versionId, effectiveGroupId, priority, scenarioId],
		queryFn: () =>
			api.cases.list(effectiveGroupId
				? { groupId: effectiveGroupId, versionId: versionId ?? undefined, priority: priority || undefined, scenarioId: scenarioId || undefined }
				: { projectId: projectId!, versionId: versionId ?? undefined, priority: priority || undefined, scenarioId: scenarioId || undefined }),
		enabled: !!projectId,
	});

	const { data: plans } = useQuery({
		queryKey: ['plans', projectId],
		queryFn: () => api.projects.plans(projectId!),
		enabled: !!projectId,
	});

	const { data: projectTags } = useQuery({
		queryKey: ['tags', projectId],
		queryFn: () => api.tags.list(projectId!),
		enabled: !!projectId,
	});

	// 场景过滤下拉的选项来源 = 项目级全量场景（来自 /api/scenarios?projectId），
	// 不再依赖当前 cases 列表 dedup，这样选中某个场景后其他选项不会消失。
	const { data: projectScenarios } = useQuery({
		queryKey: ['scenarios', projectId],
		queryFn: () => api.scenarios.listForProject(projectId!),
		enabled: !!projectId,
	});

	const groupName = useMemo(
		() => new Map((groups ?? []).map((g) => [g.id, g.name])),
		[groups],
	);

	// 新建用例的 URL 预填：分组.defaultUrl；环境兜底由服务端 resolvedUrl 负责（录制/详情链）
	const inheritUrl = (gid: string) =>
		(groups ?? []).find((g) => g.id === gid)?.defaultUrl || '';

	// 场景过滤下拉选项 = 项目下全部 scenario 去重 + 「无场景」sentinel。
	// 「无场景」是否出现，看当前列表里有没有 scenarioId == null 的用例（仅首次观察一次）。
	const scenarioOptions = useMemo(() => {
		const map = new Map<string, { id: string; title: string }>();
		for (const s of projectScenarios ?? []) {
			if (!map.has(s.id)) map.set(s.id, { id: s.id, title: s.title });
		}
		const hasNone = (cases ?? []).some((c) => c.scenarioId == null);
		const opts: Array<{ id: string; title: string }> = [];
		if (hasNone) opts.push({ id: 'none', title: '（无场景）' });
		for (const v of map.values()) opts.push(v);
		return opts;
	}, [projectScenarios, cases]);

	// 切换分组时：tab 跳回 all + 页码归 1（URL 同步）。
	// 注：useTableSelection 在下方定义，跨 useEffect 引用会撞 "used before declaration"，
	// 这里改由 DataTable 的 selection.actions.Clear 入口统一收口，避开早引用。
	useEffect(() => {
		void setRaw({ tab: 'all', page: '1' });
	}, [effectiveGroupId]);

	const invalidate = () => {
		qc.invalidateQueries({ queryKey: ['cases', projectId] });
		qc.invalidateQueries({ queryKey: ['groups', projectId] });
		qc.invalidateQueries({ queryKey: ['projects'] });
	};

	const saveGroup = useMutation({
		mutationFn: async () => {
			const body = { name: groupForm.name, defaultUrl: groupForm.defaultUrl || undefined };
			if (groupForm.mode === 'create') return api.projects.createGroup(projectId!, body);
			return api.groups.patch(groupForm.id!, body);
		},
		onSuccess: () => {
			toast('分组已保存', 'success');
			setGroupForm(EMPTY_GROUP_FORM);
			qc.invalidateQueries({ queryKey: ['groups', projectId] });
		},
		onError: (e: Error) => toast(e.message, 'error'),
	});

	const deleteGroup = useMutation({
		mutationFn: (id: string) => api.groups.remove(id),
		onSuccess: () => {
			toast('分组已删除', 'success');
			setConfirmDeleteGroup(null);
			if (effectiveGroupId) navigate(`/p/${projectId}/v/${vidParam}/groups`);
			qc.invalidateQueries({ queryKey: ['groups', projectId] });
		},
		onError: (e: Error) => {
			toast(e.message.includes('409') || e.message.includes('cases') ? '分组内仍有用例，无法删除' : e.message, 'error');
			setConfirmDeleteGroup(null);
		},
	});

	const copyCases = useMutation({
		mutationFn: async ({ caseIds, targetGroupId }: { caseIds: string[]; targetGroupId: string }) => {
			// 复制时把当前版本带过去（同版本复制；切版本复制由用户在 VersionsSelectPage 重新进入）
			if (caseIds.length === 1) return api.cases.copy(caseIds[0]!, targetGroupId, versionId ?? undefined);
			return api.cases.copyBatch(caseIds, targetGroupId, versionId ?? undefined);
		},
		onSuccess: () => {
			toast('复制完成', 'success');
			setCopyModal(null);
			setCopyTarget('');
			invalidate();
		},
		onError: (e: Error) => toast(e.message, 'error'),
	});

	const addToPlan = useMutation({
		mutationFn: async ({ caseIds, planId }: { caseIds: string[]; planId: string }) => {
			// PUT 是覆盖语义：取现有 + 追加去重
			const detail = await api.plans.get(planId);
			const merged = [...detail.cases.map((c) => c.id), ...caseIds].filter((v, i, arr) => arr.indexOf(v) === i);
			return api.plans.setCases(planId, merged);
		},
		onSuccess: () => {
			toast('已加入执行计划', 'success');
			setPlanModal(null);
			setPlanTarget('');
			qc.invalidateQueries({ queryKey: ['plans', projectId] });
		},
		onError: (e: Error) => toast(e.message, 'error'),
	});

	const deleteCase = useMutation({
		mutationFn: (id: string) => api.cases.remove(id),
		onSuccess: () => {
			toast('用例已删除', 'success');
			setConfirmDeleteCase(null);
			invalidate();
		},
		onError: (e: Error) => toast(e.message, 'error'),
	});

	// 行内执行：成功后跳到报告详情，与 CaseDetail 行为一致
	const executeCase = useMutation({
		mutationFn: (id: string) => api.cases.execute(id),
		onSuccess: (r) => {
			toast('执行完成', 'success');
			qc.invalidateQueries({ queryKey: ['reports'] });
			navigate(versionId ? `/p/${projectId}/v/${versionId}/reports/${r.reportId}` : `/`);
		},
		onError: (e: Error) => toast(e.message, 'error'),
	});

	const batchDeleteCases = useMutation({
		mutationFn: (caseIds: string[]) => api.cases.removeBatch(caseIds),
		onSuccess: (r) => {
			toast(`已删除 ${r.count} 条用例`, 'success');
			setConfirmBatchDelete(false);
			selection.clear();
			invalidate();
		},
		onError: (e: Error) => {
			toast(e.message, 'error');
			setConfirmBatchDelete(false);
		},
	});

	const batchStatus = useMutation({
		mutationFn: (status: CaseStatus) => api.cases.updateStatusBatch(selection.ids, status),
		onSuccess: (r) => {
			toast(`已更新 ${r.count} 条`, 'success');
			selection.clear();
			invalidate();
		},
		onError: (e: Error) => toast(e.message, 'error'),
	});

	// status / tag 在前端做本地筛（cases API 不接）；tab 与 status 等价语义，所以两者去重后取并集。
	const filteredCases = useMemo(() => {
		let list = cases ?? [];
		// status 过滤：tab='all' 表示不过滤，其他 tab 等价 status 单选
		if (tab !== 'all') list = list.filter((c) => c.status === tab);
		if (statusSelected.length > 0) list = list.filter((c) => statusSelected.includes(c.status));
		if (tagSelected.length > 0) list = list.filter((c) => (c.tags ?? []).some((t) => tagSelected.includes(t.id)));
		if (q.trim()) {
			const needle = q.trim().toLowerCase();
			list = list.filter((c) => c.title.toLowerCase().includes(needle));
		}
		return list;
	}, [cases, tab, statusSelected, tagSelected, q]);

	// DataTable 默认 client-side 切页；每页条数由 URL `?pageSize=` 决定，rows 也用同一变量。
	const rows = useMemo(
		() => filteredCases.slice((page - 1) * pageSize, page * pageSize),
		[filteredCases, page, pageSize],
	);
	const total = filteredCases.length;

	// 表格批量选择：ids 用于批量操作；toggleAll 当前页全集 / clear 一键清空
	const selection = useTableSelection(rows.map((r) => r.id));

	// 切 tab 时清空勾选（避免跨 tab 误选），沿用旧 useEffect 行为
	useEffect(() => { selection.clear(); }, [tab]);

	const setPriorityFilter = (next: typeof priority) => void setRaw({ priority: next, page: '1' });
	const setScenarioFilter = (next: string) => void setRaw({ scenario: next, page: '1' });
	const setStatusFilter = (next: string[]) => void setRaw({ status: next, page: '1' });
	const setTagFilter = (next: string[]) => void setRaw({ tag: next, page: '1' });
	const setPage = (next: number) => void setRaw({ page: String(next) });
	const setPageSize = (next: number) => void setRaw({ pageSize: String(next), page: '1' });
	const setTabFilter = (next: typeof tab) => void setRaw({ tab: next, page: '1' });
	const setSearch = (next: string) => void setRaw({ q: next, page: '1' });

	const tabs: DataTableTabs = {
		id: 'tab',
		allLabel: '全部',
		options: [
			{ value: 'draft', label: '草稿' },
			{ value: 'review', label: '评审中' },
			{ value: 'ready', label: '就绪' },
			{ value: 'deprecated', label: '废弃' },
		],
	};

	const facets: DataTableFacet[] = [
		{
			id: 'priority',
			label: '优先级',
			options: PRIORITY_VALUES.filter((p) => p !== '').map((p) => ({ value: p, label: p })),
		},
		{
			id: 'scenario',
			label: '场景',
			options: scenarioOptions.map((o) => ({ value: o.id, label: o.title })),
		},
		{
			id: 'status',
			label: '状态',
			options: STATUS_FILTER_VALUES.filter((s) => s !== '').map((s) => ({ value: s, label: caseStatusLabel(s) })),
		},
		{
			id: 'tag',
			label: '标签',
			options: (projectTags ?? []).map((t) => ({ value: t.id, label: t.name })),
		},
	];

	const columnsDef: DataTableColumn<TestCase>[] = [
		{
				id: 'priority',
				header: '优先级',
				width: 'w-[64px]',
				hideBelow: 'md',
				cell: (c) => <PriorityBadge priority={c.priority} />,
			},
			{
				id: 'title',
				header: '标题',
				sortable: false,
				cell: (c) => (
					<span className="font-semibold truncate">{c.title}</span>
				),
				cellClassName: 'min-w-0',
			},
			{
				id: 'group',
				header: '所属分组',
				width: 'w-[140px]',
				hideBelow: 'lg',
				cellClassName: 'text-muted-foreground',
				cell: (c) => (c.groupId ? <span className="truncate">{groupName.get(c.groupId) ?? <EmptyCellValue />}</span> : <EmptyCellValue />),
			},
			{
				id: 'scenario',
				header: '场景',
				width: 'w-[140px]',
				hideBelow: 'lg',
				cellClassName: 'text-muted-foreground',
				cell: (c) => (
					<span className="truncate" title={c.scenarioTitle ?? undefined}>
						{c.scenarioTitle ?? <EmptyCellValue />}
					</span>
				),
			},
			{
				id: 'tags',
				header: '标签',
				width: 'w-[180px]',
				hideBelow: 'md',
				cell: (c) => {
					const tags = c.tags ?? [];
					if (tags.length === 0) return <EmptyCellValue />;
					return (
						<span className="flex items-center gap-1 flex-wrap min-w-0">
							{tags.slice(0, MAX_TAG_CHIPS).map((t) => (
								<TagChip key={t.id} tag={t} />
							))}
							{tags.length > MAX_TAG_CHIPS && (
								<span className="text-[11px] text-muted-foreground">+{tags.length - MAX_TAG_CHIPS}</span>
							)}
						</span>
					);
				},
			},
			{
				id: 'status',
				header: '状态',
				width: 'w-[120px]',
				cell: (c) => <CaseStatusMenu caseId={c.id} status={c.status} projectId={projectId} />,
			},
			{
				id: 'updatedAt',
				header: '更新时间',
				width: 'w-[110px]',
				align: 'right',
				cellClassName: 'text-xs text-muted-foreground tabular-nums',
				cell: (c) => (c.updatedAt ? <span title={c.updatedAt}>{shortDateTime(c.updatedAt)}</span> : <EmptyCellValue />),
			},
			{
				id: 'actions',
				header: '',
				width: 'w-[112px]',
				align: 'right',
				hideable: false,
				cell: (c) => (
					<span
						className="flex items-center justify-end gap-1"
						onClick={(e) => e.stopPropagation()}
					>
						<IconButton
							icon={executeCase.isPending && executeCase.variables === c.id ? 'loader' : 'play'}
							title="执行"
							tone="accent"
							disabled={executeCase.isPending && executeCase.variables === c.id}
							onClick={() => executeCase.mutate(c.id)}
						/>
						<IconButton
							icon="copy"
							title="复制"
							onClick={() => { setCopyTarget(''); setCopyModal({ caseIds: [c.id] }); }}
						/>
						<IconButton
							icon="trash"
							title="删除"
							tone="destructive"
							onClick={() => setConfirmDeleteCase({ id: c.id, title: c.title })}
						/>
					</span>
				),
			},
		];

	const startAiCaseSession = useMutation({
		// 直接跳到空间级 AI 助手(/assistant);旧 requirement 级工作台保留为兼容路由,
		// 不再从此入口创建。首条消息 = 需求正文 + 覆盖要求。
		mutationFn: () => Promise.resolve(),
		onSuccess: () => {
			const initialMessage = aiForm.content + coveragePrompt(aiForm.coverage);
			setAiForm(EMPTY_AI_FORM);
			navigate(versionId ? `/p/${projectId}/v/${versionId}/assistant` : `/`, {
				state: { initialMessage },
			});
		},
		onError: (e: Error) => toast(e.message, 'error'),
	});

	// 手动新建用例：成功后跳到详情页继续编辑步骤
	const createCase = useMutation({
		mutationFn: () =>
			api.cases.create({
				title: caseForm.title.trim(),
				groupId: caseForm.groupId,
				versionId: versionId ?? undefined,
				priority: caseForm.priority,
				url: caseForm.url.trim() || undefined,
				description: caseForm.description.trim() || undefined,
			}),
		onSuccess: (r) => {
			toast('用例已创建', 'success');
			setCaseForm(EMPTY_CASE_FORM);
			invalidate();
			navigate(versionId ? `/p/${projectId}/v/${versionId}/cases/${r.id}` : `/`);
		},
		onError: (e: Error) => toast(e.message, 'error'),
	});

	return (
		<PageShell contained>
			<PageShellHeader>
				<PageShellTitle>用例</PageShellTitle>
				<PageShellDescription>
					{effectiveGroupId ? (groupName.get(effectiveGroupId) ?? '分组') : '项目全部用例'} · {current?.name}
				</PageShellDescription>
				<PageShellActions>
					<Button
						onClick={() => {
							const gid = effectiveGroupId || groups?.[0]?.id || '';
							setCaseForm({ ...EMPTY_CASE_FORM, open: true, groupId: gid, url: inheritUrl(gid) });
						}}
					>
						<Icon name="plus" size={12} />
						新建用例
					</Button>
					<Button onClick={() => setAiForm({ ...EMPTY_AI_FORM, open: true })}>
						<Icon name="bolt" size={12} />
						AI 创建用例
					</Button>
				</PageShellActions>
			</PageShellHeader>

			<PageShellContent>
				<div className="flex flex-1 min-h-0">
					{/* 左侧分组树 */}
					<div
						className="shrink-0 flex flex-col overflow-y-auto"
						style={{ width: 216, borderRight: '1px solid var(--border)', padding: '10px 8px' }}
					>
						<div className="flex items-center justify-between px-2 py-1">
							<span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--muted-foreground)' }}>
								分组
							</span>
							<button
								title="新建分组"
								onClick={() => setGroupForm({ open: true, mode: 'create', id: null, name: '', defaultUrl: '' })}
								style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--muted-foreground)', padding: 2 }}
							>
								<Icon name="plus" size={13} />
							</button>
						</div>

						<button
							data-active={!effectiveGroupId || undefined}
							onClick={() => navigate(versionId ? `/p/${projectId}/v/${versionId}/groups` : `/`)}
							className="group-nav-item text-left px-2 py-1.5 rounded-[var(--radius-sm)] text-[13px]"
							style={{
								color: !effectiveGroupId ? 'var(--primary)' : 'var(--muted-foreground)',
								fontWeight: !effectiveGroupId ? 500 : 400,
								border: 'none', cursor: 'pointer',
							}}
						>
							全部用例（{cases?.length ?? 0}）
						</button>

						{groupsLoading ? (
							<div className="flex justify-center py-4" style={{ color: 'var(--muted-foreground)' }}>
								<Icon name="loader" size={14} className="animate-spin" />
							</div>
						) : (
							(groups ?? []).map((g) => {
								const active = effectiveGroupId === g.id;
								return (
									<div
										key={g.id}
										data-active={active || undefined}
										onClick={() => navigate(versionId ? `/p/${projectId}/v/${versionId}/groups/${g.id}` : `/`)}
										className="group-nav-item group flex items-center gap-1 px-2 py-1.5 rounded-[var(--radius-sm)] cursor-pointer"
									>
										<Icon name="gitBranch" size={12} style={{ color: 'var(--muted-foreground)', flexShrink: 0 }} />
										<span
											className="flex-1 truncate text-[13px]"
											style={{ color: active ? 'var(--primary)' : 'var(--muted-foreground)', fontWeight: active ? 500 : 400 }}
											title={g.defaultUrl ?? undefined}
										>
											{g.name}
										</span>
										<span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{g.caseCount}</span>
										<span className="hidden group-hover:flex items-center" onClick={(e) => e.stopPropagation()}>
											<IconButton
												icon="pencil"
												title="重命名"
												onClick={() => setGroupForm({ open: true, mode: 'edit', id: g.id, name: g.name, defaultUrl: g.defaultUrl ?? '' })}
											/>
											<IconButton
												icon="trash"
												title="删除分组"
												tone="destructive"
												onClick={() => setConfirmDeleteGroup({ id: g.id, name: g.name })}
											/>
										</span>
									</div>
								);
							})
						)}
					</div>

					{/* 右侧用例表 */}
					<div className="flex-1 min-w-0 flex flex-col overflow-hidden p-3">
						{casesError ? (
							<div className="flex flex-1 items-center justify-center text-muted-foreground" style={{ fontSize: 13 }}>
								加载失败：{casesErrorObj?.message ?? '未知错误'}
							</div>
						) : (
							<DataTable<TestCase>
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
										setTab: (v) => setTabFilter(v as typeof tab),
										setFilter: (id, values) => {
											if (id === 'priority') setPriorityFilter((values[0] ?? '') as typeof priority);
											else if (id === 'scenario') setScenarioFilter(values[0] ?? '');
											else if (id === 'status') setStatusFilter(values);
											else if (id === 'tag') setTagFilter(values);
										},
										filters: {
											priority: priority ? [priority] : [],
											scenario: scenarioId ? [scenarioId] : [],
											status: statusSelected,
											tag: tagSelected,
										},
									}}
								columns={columnsDef}
								getRowId={(r) => r.id}
								rows={rows}
								total={total}
								loading={casesLoading}
								facets={facets}
								tabs={tabs}
								onRowClick={(c) => navigate(versionId ? `/p/${projectId}/v/${versionId}/cases/${c.id}` : `/`)}
								selection={{ state: selection, actions: (
									<>
										<Button size="sm" variant="ghost" onClick={() => { setCopyTarget(''); setCopyModal({ caseIds: selection.ids }); }}>
											<Icon name="copy" size={12} />
											批量复制
										</Button>
										<Button size="sm" variant="ghost" onClick={() => { setPlanTarget(''); setPlanModal({ caseIds: selection.ids }); }}>
											<Icon name="play" size={12} />
											加入计划
										</Button>
										<select
											aria-label="批量修改状态"
											className="h-7 rounded-md border border-border bg-background px-2 text-xs outline-none cursor-pointer"
											value=""
											disabled={batchStatus.isPending}
											onChange={(e) => {
												if (e.target.value) batchStatus.mutate(e.target.value as CaseStatus);
											}}
										>
											<option value="">改状态…</option>
											<option value="draft">→ 草稿</option>
											<option value="review">→ 评审中</option>
											<option value="ready">→ 就绪</option>
											<option value="deprecated">→ 废弃</option>
										</select>
										<Button size="sm" variant="destructive" onClick={() => setConfirmBatchDelete(true)}>
											<Icon name="trash" size={12} />
											批量删除
										</Button>
									</>
								) }}
								search={(
									<div className="relative w-full sm:max-w-xs">
										<Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
										<Input
											value={q}
											onChange={(e) => setSearch(e.target.value)}
											placeholder="搜索用例标题…"
											className="pl-7"
											size="sm"
										/>
									</div>
								)}
								empty={
									<EmptyState icon="beaker" title="还没有用例" description="点击右上角「AI 创建用例」，粘贴需求让 AI 生成。" />
								}
							/>
						)}
					</div>
				</div>
			</PageShellContent>

			{/* 分组弹窗（新建/重命名/默认域名） */}
			<Dialog open={groupForm.open} onOpenChange={(open) => setGroupForm((f) => ({ ...f, open }))}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							{groupForm.mode === 'create' ? '新建分组' : '重命名分组'}
						</DialogTitle>
					</DialogHeader>
					<div className="flex flex-col gap-3 px-5 py-4">
						<Input label="名称" placeholder="如：登录与账号" value={groupForm.name} onChange={(e) => setGroupForm((f) => ({ ...f, name: e.target.value }))} />
						<Input
							label="默认域名（可空）"
							placeholder="https://example.com"
							value={groupForm.defaultUrl}
							onChange={(e) => setGroupForm((f) => ({ ...f, defaultUrl: e.target.value }))}
						/>
					</div>
					<div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--border)' }}>
						<Button variant="ghost" onClick={() => setGroupForm(EMPTY_GROUP_FORM)}>取消</Button>
						<Button
							disabled={!groupForm.name.trim() || saveGroup.isPending}
							onClick={() => saveGroup.mutate()}
						>
							{saveGroup.isPending ? '保存中...' : '保存'}
						</Button>
					</div>
				</DialogContent>
			</Dialog>

			{/* 删除分组确认 */}
			<Dialog open={!!confirmDeleteGroup} onOpenChange={(open) => { if (!open) setConfirmDeleteGroup(null); }}>
				<DialogContent>
					<DialogHeader><DialogTitle>删除分组</DialogTitle></DialogHeader>
					<div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
						确定删除「{confirmDeleteGroup?.name}」？分组内存在用例时将被拒绝删除。
					</div>
					<div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--border)' }}>
						<Button variant="ghost" onClick={() => setConfirmDeleteGroup(null)}>取消</Button>
						<Button variant="destructive" disabled={deleteGroup.isPending} onClick={() => confirmDeleteGroup && deleteGroup.mutate(confirmDeleteGroup.id)}>
							{deleteGroup.isPending ? '删除中...' : '确认删除'}
						</Button>
					</div>
				</DialogContent>
			</Dialog>

			{/* 删除用例确认 */}
			<Dialog open={!!confirmDeleteCase} onOpenChange={(open) => { if (!open) setConfirmDeleteCase(null); }}>
				<DialogContent>
					<DialogHeader><DialogTitle>删除用例</DialogTitle></DialogHeader>
					<div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
						确定删除「{confirmDeleteCase?.title}」？该用例的步骤与报告将一并删除。
					</div>
					<DialogFooter>
						<Button variant="ghost" onClick={() => setConfirmDeleteCase(null)}>取消</Button>
						<Button variant="destructive" disabled={deleteCase.isPending} onClick={() => confirmDeleteCase && deleteCase.mutate(confirmDeleteCase.id)}>
							{deleteCase.isPending ? '删除中...' : '确认删除'}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* 批量删除确认 */}
			<Dialog open={confirmBatchDelete} onOpenChange={(open) => { if (!open) setConfirmBatchDelete(false); }}>
				<DialogContent>
					<DialogHeader><DialogTitle>批量删除用例</DialogTitle></DialogHeader>
					<div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
						确定删除已选的 <span style={{ color: 'var(--destructive)', fontWeight: 600 }}>{selection.count}</span> 条用例？这些用例的步骤、报告、附件将被一并删除，且不可恢复。
					</div>
					<DialogFooter>
						<Button variant="ghost" onClick={() => setConfirmBatchDelete(false)}>取消</Button>
						<Button
							variant="destructive"
							disabled={batchDeleteCases.isPending || selection.count === 0}
							onClick={() => batchDeleteCases.mutate(selection.ids)}
						>
							{batchDeleteCases.isPending ? '删除中...' : `删除 ${selection.count} 条`}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* 复制目标分组弹窗 */}
			<Dialog open={!!copyModal} onOpenChange={(open) => { if (!open) setCopyModal(null); }}>
				<DialogContent>
					<DialogHeader><DialogTitle>复制用例（{copyModal?.caseIds.length} 条）</DialogTitle></DialogHeader>
					<div className="flex flex-col gap-3 px-5 py-4">
						<label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-foreground)' }}>目标分组</label>
						<select className="input-base" value={copyTarget} onChange={(e) => setCopyTarget(e.target.value)}>
							<option value="">请选择</option>
							{(groups ?? []).map((g) => (
								<option key={g.id} value={g.id}>{g.name}</option>
							))}
						</select>
						<p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
							副本命名：原名 +「副本」，重名自动追加数字（副本1、副本2…）。
						</p>
					</div>
					<DialogFooter>
						<Button variant="ghost" onClick={() => setCopyModal(null)}>取消</Button>
						<Button
							disabled={!copyTarget || copyCases.isPending}
							onClick={() => copyModal && copyCases.mutate({ caseIds: copyModal.caseIds, targetGroupId: copyTarget })}
						>
							{copyCases.isPending ? '复制中...' : '复制'}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* 加入计划弹窗 */}
			<Dialog open={!!planModal} onOpenChange={(open) => { if (!open) setPlanModal(null); }}>
				<DialogContent>
					<DialogHeader><DialogTitle>加入执行计划（{planModal?.caseIds.length} 条）</DialogTitle></DialogHeader>
					<div className="flex flex-col gap-3 px-5 py-4">
						<label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-foreground)' }}>选择计划</label>
						<select className="input-base" value={planTarget} onChange={(e) => setPlanTarget(e.target.value)}>
							<option value="">请选择</option>
							{(plans ?? []).map((p) => (
								<option key={p.id} value={p.id}>{p.name}{p.environment ? `（${p.environment}）` : ''}</option>
							))}
						</select>
						{(plans ?? []).length === 0 && (
							<p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
								还没有执行计划，请先到「执行计划」页创建。
							</p>
						)}
					</div>
					<DialogFooter>
						<Button variant="ghost" onClick={() => setPlanModal(null)}>取消</Button>
						<Button
							disabled={!planTarget || addToPlan.isPending}
							onClick={() => planModal && addToPlan.mutate({ caseIds: planModal.caseIds, planId: planTarget })}
						>
							{addToPlan.isPending ? '添加中...' : '加入'}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* AI 创建用例 — 收集需求标题/内容后跳到 AI 工作台 */}
			<Dialog open={aiForm.open} onOpenChange={(open) => setAiForm((f) => ({ ...f, open }))}>
				<DialogContent>
					<DialogHeader><DialogTitle>AI 创建用例</DialogTitle></DialogHeader>
					<div className="flex flex-col gap-3 px-5 py-4">
						<p className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
							描述要测的需求，AI 会基于此生成场景和用例。
						</p>
						<Input
							label="需求标题"
							placeholder="如：登录与账号体系"
							value={aiForm.title}
							onChange={(e) => setAiForm((f) => ({ ...f, title: e.target.value }))}
						/>
						<div className="flex flex-col gap-1">
							<label className="text-[12px] font-medium" style={{ color: 'var(--muted-foreground)' }}>
								需求描述
							</label>
							<textarea
								className="input-base"
								rows={6}
								placeholder="把要测的需求贴在这里，AI 会拆解为场景与用例。"
								value={aiForm.content}
								onChange={(e) => setAiForm((f) => ({ ...f, content: e.target.value }))}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<label className="text-[12px] font-medium" style={{ color: 'var(--muted-foreground)' }}>
								覆盖类型（勾选 = 必须覆盖，未勾选由 AI 自行判断）
							</label>
							<div className="flex flex-wrap gap-x-4 gap-y-1.5">
								{COVERAGE_TYPES.map((t) => (
									<label key={t.key} className="flex items-center gap-1.5 text-[13px] cursor-pointer" style={{ color: 'var(--foreground)' }}>
										<input
											type="checkbox"
											checked={aiForm.coverage.includes(t.key)}
											onChange={() =>
												setAiForm((f) => ({
													...f,
													coverage: f.coverage.includes(t.key)
														? f.coverage.filter((x) => x !== t.key)
														: [...f.coverage, t.key],
												}))
											}
										/>
										{t.label}
									</label>
								))}
							</div>
						</div>
					</div>
					<div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--border)' }}>
						<Button variant="ghost" onClick={() => setAiForm(EMPTY_AI_FORM)}>取消</Button>
						<Button
							disabled={!aiForm.title.trim() || !aiForm.content.trim() || startAiCaseSession.isPending}
							onClick={() => startAiCaseSession.mutate()}
						>
							{startAiCaseSession.isPending ? '打开中...' : '开始 AI 会话'}
						</Button>
					</div>
				</DialogContent>
			</Dialog>

			{/* 手动新建用例 */}
			<Dialog open={caseForm.open} onOpenChange={(open) => setCaseForm((f) => ({ ...f, open }))}>
				<DialogContent>
					<DialogHeader><DialogTitle>新建用例</DialogTitle></DialogHeader>
					<div className="flex flex-col gap-3 px-5 py-4">
						<Input
							label="标题"
							placeholder="如：登录 - 正确账号密码"
							value={caseForm.title}
							onChange={(e) => setCaseForm((f) => ({ ...f, title: e.target.value }))}
						/>
						<div className="flex flex-col gap-1">
							<label className="text-[12px] font-medium" style={{ color: 'var(--muted-foreground)' }}>分组</label>
							<select
								className="input-base"
								value={caseForm.groupId}
								onChange={(e) =>
									setCaseForm((f) => {
										// 换分组时：URL 为空或还是上一个分组的继承值 → 重新继承；用户已手输则保留
										const prev = inheritUrl(f.groupId);
										return {
											...f,
											groupId: e.target.value,
											url: !f.url || f.url === prev ? inheritUrl(e.target.value) : f.url,
										};
									})
								}
								disabled={(groups ?? []).length === 0}
							>
								{(groups ?? []).length === 0 && <option value="">请先创建分组</option>}
								{(groups ?? []).map((g) => (
									<option key={g.id} value={g.id}>{g.name}</option>
								))}
							</select>
						</div>
						<div className="flex flex-col gap-1">
							<label className="text-[12px] font-medium" style={{ color: 'var(--muted-foreground)' }}>优先级</label>
							<Segmented
								options={(['P0', 'P1', 'P2', 'P3'] as const).map((p) => ({ value: p, label: p }))}
								value={caseForm.priority}
								onChange={(v) => setCaseForm((f) => ({ ...f, priority: v }))}
							/>
						</div>
						<Input
							label="URL（可空）"
							placeholder="https://example.com/login"
							value={caseForm.url}
							onChange={(e) => setCaseForm((f) => ({ ...f, url: e.target.value }))}
						/>
						<div className="flex flex-col gap-1">
							<label className="text-[12px] font-medium" style={{ color: 'var(--muted-foreground)' }}>描述（可空）</label>
							<textarea
								className="input-base"
								rows={3}
								placeholder="补充前置条件、测试要点等。"
								value={caseForm.description}
								onChange={(e) => setCaseForm((f) => ({ ...f, description: e.target.value }))}
							/>
						</div>
					</div>
					<div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--border)' }}>
						<Button variant="ghost" onClick={() => setCaseForm(EMPTY_CASE_FORM)}>取消</Button>
						<Button
							disabled={!caseForm.title.trim() || !caseForm.groupId || createCase.isPending}
							onClick={() => createCase.mutate()}
						>
							{createCase.isPending ? '创建中...' : '创建'}
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</PageShell>
	);
}

