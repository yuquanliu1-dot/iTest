import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { localizeApiError } from '../i18n';
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
import StatusPill from '../components/ui/StatusPill';
import TagChip from '../components/ui/Tag';
import IconButton from '../components/ui/IconButton';
import { EmptyCellValue } from '../components/ui/Table';
import { DataTable, type DataTableColumn, type DataTableFacet, type DataTableTabs } from '../components/ui/DataTable';
import { useTableSelection } from '../hooks/useTableSelection';
import { batchProgressPercent, runningCaseIds } from '../lib/solidifyProgress';
import { caseStatusLabel, shortDateTime } from '../lib/format';
import { creatorName } from '../lib/creatorName';
import { COVERAGE_TYPES, coveragePrompt } from '@itest/shared';
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
/** Case pool scope: current version / whole product line (cross-project cross-version, as a shared case library) */
const SCOPE_VALUES = ['version', 'line'] as const;

const caseParsers = {
	q: parseAsString.withDefault(''),
	page: parseAsString.withDefault('1'),
	pageSize: parseAsString.withDefault('20'),
	priority: parseAsStringEnum([...PRIORITY_VALUES]).withDefault(''),
	scenario: parseAsString.withDefault(''),
	status: parseAsArrayOf(parseAsString).withDefault([]),
	projects: parseAsArrayOf(parseAsString).withDefault([]),
	tag: parseAsArrayOf(parseAsString).withDefault([]),
	versions: parseAsArrayOf(parseAsString).withDefault([]),
	solidified: parseAsArrayOf(parseAsString).withDefault([]),
	// Batch id I triggered (survives leaving the page/refreshing, so the "this batch finished" notice can still reconnect)
	solidifyBatchId: parseAsString.withDefault(''),
	tab: parseAsStringEnum([...TAB_VALUES]).withDefault('all'),
	// tab is already taken by status filtering, so the scope tab gets its own key
	scope: parseAsStringEnum([...SCOPE_VALUES]).withDefault('version'),
};

type GroupForm = { open: boolean; mode: 'create' | 'edit'; id: string | null; name: string };
const EMPTY_GROUP_FORM: GroupForm = { open: false, mode: 'create', id: null, name: '' };
type AiForm = { open: boolean; title: string; content: string; coverage: string[] };
const DEFAULT_COVERAGE = ['functional', 'exception'];
const EMPTY_AI_FORM: AiForm = { open: false, title: '', content: '', coverage: DEFAULT_COVERAGE };

type CasePriority = 'P0' | 'P1' | 'P2' | 'P3';
type CaseForm = { open: boolean; title: string; groupId: string; priority: CasePriority; description: string };
const EMPTY_CASE_FORM: CaseForm = { open: false, title: '', groupId: '', priority: 'P1', description: '' };

export default function GroupsPage() {
	const { projectId, groupId, versionId: vidParam } = useParams<{ projectId: string; groupId: string; versionId: string }>();
	const versionId = vidParam ?? null;
	const navigate = useNavigate();
	const toast = useUIStore((s) => s.showToast);
	const qc = useQueryClient();
	const { t } = useTranslation();
	const current = useProjectStore((s) => s.current);

	const [raw, setRaw] = useQueryStates(caseParsers, { history: 'replace' });
	const q = raw.q;
	const priority = raw.priority;
	const scenarioId = raw.scenario;
	const statusSelected = raw.status;
	const tagSelected = raw.tag;
	const projectsSelected = raw.projects;
	const versionsSelected = raw.versions;
	const solidifiedSelected = raw.solidified;
	const tab = raw.tab;
	const scope = raw.scope;
	const onLineScope = scope === 'line';
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
	const [confirmBatchSolidify, setConfirmBatchSolidify] = useState(false);
	const [aiForm, setAiForm] = useState<AiForm>(EMPTY_AI_FORM);
	const [caseForm, setCaseForm] = useState<CaseForm>(EMPTY_CASE_FORM);

	const { data: scopeProject } = useQuery({
		queryKey: ['project', projectId],
		queryFn: () => api.projects.get(projectId!),
		enabled: !!projectId,
	});
	const productLineId = scopeProject?.productLineId ?? null;

	// Group counts follow the scope and version filter: current version locks to the current version; line scope counts the selected version set (none selected = whole line).
	// Otherwise the left rail's numbers would stay constant across scopes and mismatch the table on the right.
	const groupCountVersionIds = onLineScope
		? versionsSelected
		: versionId
			? [versionId]
			: [];
	const groupCountKey = groupCountVersionIds.join(',');
	const { data: groups, isLoading: groupsLoading } = useQuery({
		queryKey: ['groups', projectId, groupCountKey],
		queryFn: () => api.projects.groups(projectId!, groupCountVersionIds),
		enabled: !!projectId,
	});

	const effectiveGroupId = groupId ?? '';
	// When fetching the list, only pass through the filters the backend supports (priority/scenarioId/versionIds); status/tags/group drill-down are filtered locally on the frontend.
	// The "current version" scope is always locked to the current version and always fetches the whole version — the queryKey excludes groupId, so group drill-down never shrinks the data plane:
	// otherwise the left rail's "all cases" count would shrink to this group's count (hit in practice), and every group switch would burn a request wait;
	// the "product line" scope fetches everything across projects and versions.
	const { data: cases, isLoading: casesLoading, isError: casesError, error: casesErrorObj } = useQuery({
		queryKey: ['cases', projectId, scope, priority, scenarioId, productLineId, onLineScope ? versionsSelected : [], solidifiedSelected],
		queryFn: () => {
			const base = {
				priority: priority || undefined,
				scenarioId: scenarioId || undefined,
				// Unsolidified only (the bulk-solidify entry's standard): has steps and all compiled empty, aggregated and filtered by the backend
				solidified: solidifiedSelected.length > 0 ? 'none' : undefined,
			};
			if (onLineScope && productLineId) {
				return api.cases.list({ ...base, productLineId, versionIds: versionsSelected.length ? versionsSelected : undefined });
			}
			return api.cases.list({
				projectId: projectId!,
				...base,
				versionIds: [versionId!],
			});
		},
		enabled: !!projectId && !!versionId,
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

	// Scenario filter dropdown option source = project-level full scenario list (from /api/scenarios?projectId),
	// no longer deduped from the current cases list, so picking one scenario does not make the other options disappear.
	const { data: projectScenarios } = useQuery({
		queryKey: ['scenarios', projectId],
		queryFn: () => api.scenarios.listForProject(projectId!),
		enabled: !!projectId,
	});

	// Under line scope the list mixes projects, so group names must be looked up across all groups in the line, otherwise sibling projects' rows render empty.
	const { data: lineGroups } = useQuery({
		queryKey: ['groups', 'line', productLineId],
		queryFn: () => api.projects.groupsByProductLine(productLineId!),
		enabled: !!productLineId,
	});
	const { data: lineVersions } = useQuery({
		queryKey: ['versions', 'line', productLineId],
		queryFn: () => api.projects.versionsByProductLine(productLineId!),
		enabled: !!productLineId,
	});

	const groupName = useMemo(
		() => new Map((onLineScope ? lineGroups ?? [] : groups ?? []).map((g) => [g.id, g.name])),
		[groups, lineGroups, onLineScope],
	);

	// Scenario filter dropdown options = all scenarios under the project deduped + a "no scenario" sentinel.
	// Whether "no scenario" appears depends on whether the current list has a case with scenarioId == null (observed once on first load only).
	const scenarioOptions = useMemo(() => {
		const map = new Map<string, { id: string; title: string }>();
		for (const s of projectScenarios ?? []) {
			if (!map.has(s.id)) map.set(s.id, { id: s.id, title: s.title });
		}
		const hasNone = (cases ?? []).some((c) => c.scenarioId == null);
		const opts: Array<{ id: string; title: string }> = [];
		if (hasNone) opts.push({ id: 'none', title: t('groups:noScenario') });
		for (const v of map.values()) opts.push(v);
		return opts;
	}, [projectScenarios, cases, t]);

	// On group switch: tab jumps back to all + page resets to 1 (URL sync).
	// Note: useTableSelection is defined further below; a cross-useEffect reference would hit "used before declaration",
	// so clearing is funneled through DataTable's selection.actions.Clear entry instead, avoiding the early reference.
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
			const body = { name: groupForm.name };
			if (groupForm.mode === 'create') return api.projects.createGroup(projectId!, body);
			return api.groups.patch(groupForm.id!, body);
		},
		onSuccess: () => {
			toast(t('groups:groupSaved'), 'success');
			setGroupForm(EMPTY_GROUP_FORM);
			qc.invalidateQueries({ queryKey: ['groups', projectId] });
		},
		onError: (e: Error) => toast(localizeApiError(e), 'error'),
	});

	const deleteGroup = useMutation({
		mutationFn: (id: string) => api.groups.remove(id),
		onSuccess: () => {
			toast(t('groups:groupDeleted'), 'success');
			setConfirmDeleteGroup(null);
			if (effectiveGroupId) navigate(`/p/${projectId}/v/${vidParam}/groups`);
			qc.invalidateQueries({ queryKey: ['groups', projectId] });
		},
		onError: (e: Error) => {
			toast(e.message.includes('409') || e.message.includes('cases') ? t('groups:groupDeleteBlocked') : e.message, 'error');
			setConfirmDeleteGroup(null);
		},
	});

	const copyCases = useMutation({
		mutationFn: async ({ caseIds, targetGroupId }: { caseIds: string[]; targetGroupId: string }) => {
			// Copy carries the current version along (same-version copy; cross-version copy means the user re-enters via VersionsSelectPage)
			if (caseIds.length === 1) return api.cases.copy(caseIds[0]!, targetGroupId, versionId ?? undefined);
			return api.cases.copyBatch(caseIds, targetGroupId, versionId ?? undefined);
		},
		onSuccess: () => {
			toast(t('groups:copyDone'), 'success');
			setCopyModal(null);
			setCopyTarget('');
			invalidate();
		},
		onError: (e: Error) => toast(localizeApiError(e), 'error'),
	});

	const addToPlan = useMutation({
		mutationFn: async ({ caseIds, planId }: { caseIds: string[]; planId: string }) => {
			// Append semantics: the POST lands in the first group (a default group is auto-created when there is none); in-group dedup is the server's job
			return api.plans.addCases(planId, caseIds);
		},
		onSuccess: () => {
			toast(t('groups:addedToPlan'), 'success');
			setPlanModal(null);
			setPlanTarget('');
			qc.invalidateQueries({ queryKey: ['plans', projectId] });
		},
		onError: (e: Error) => toast(localizeApiError(e), 'error'),
	});

	const deleteCase = useMutation({
		mutationFn: (id: string) => api.cases.remove(id),
		onSuccess: () => {
			toast(t('groups:caseDeleted'), 'success');
			setConfirmDeleteCase(null);
			// Single delete after row selection: without cleanup the deleted id stays in selection and the toolbar keeps showing "1 selected"
			selection.clear();
			invalidate();
		},
		onError: (e: Error) => toast(localizeApiError(e), 'error'),
	});

	// Inline execute: jump to the report detail on success, consistent with CaseDetail
	const executeCase = useMutation({
		mutationFn: (id: string) => api.cases.execute(id),
		onSuccess: (r) => {
			toast(t('groups:executeDone'), 'success');
			qc.invalidateQueries({ queryKey: ['reports'] });
			navigate(versionId ? `/p/${projectId}/v/${versionId}/reports/${r.reportId}` : `/`);
		},
		onError: (e: Error) => toast(localizeApiError(e), 'error'),
	});

	const batchDeleteCases = useMutation({
		mutationFn: (caseIds: string[]) => api.cases.removeBatch(caseIds),
		onSuccess: (r) => {
			toast(t('groups:deletedCases', { count: r.count }), 'success');
			setConfirmBatchDelete(false);
			selection.clear();
			invalidate();
		},
		onError: (e: Error) => {
			toast(localizeApiError(e), 'error');
			setConfirmBatchDelete(false);
		},
	});

	const batchStatus = useMutation({
		mutationFn: (status: CaseStatus) => api.cases.updateStatusBatch(selection.ids, status),
		onSuccess: (r) => {
			toast(t('groups:updatedCases', { count: r.count }), 'success');
			selection.clear();
			invalidate();
		},
		onError: (e: Error) => toast(localizeApiError(e), 'error'),
	});

	// Bulk backend solidify: after triggering, poll batch progress (2s); on completion show a summary toast and refresh the list.
	// batchId is stored in the URL (nuqs): leaving the page/refreshing and coming back still reconnects the "my batch" completion notice.
	const solidifyBatchId = raw.solidifyBatchId || null;
	const batchSolidifyCases = useMutation({
		mutationFn: (caseIds: string[]) => api.cases.batchSolidify(caseIds),
		onSuccess: (r) => {
			setConfirmBatchSolidify(false);
			if (r.rejected.length > 0) {
				// Partially/all rejected: show the first human-readable reason (enumerating every item on the frontend would flood the screen when there are many)
				toast(t('groups:batchSolidifyRejected', { count: r.rejected.length, reason: r.rejected[0]!.reason }), 'error');
			}
			if (r.batchId) {
				toast(t('groups:batchSolidifyStarted', { count: r.accepted.length }), 'success');
				void setRaw({ solidifyBatchId: r.batchId });
				selection.clear();
			}
		},
		onError: (e: Error) => {
			toast(localizeApiError(e), 'error');
			setConfirmBatchSolidify(false);
		},
	});
	// In-flight batch overview (data source for the top banner + the inline "solidifying" badge): covers all visible projects,
	// including batches triggered by others; poll at 2s while any batch is in flight, stop once all are terminal.
	const { data: solidifyOverview } = useQuery({
		queryKey: ['solidify-batches', projectId],
		queryFn: () => api.cases.solidifyBatches(projectId!),
		enabled: !!projectId,
		refetchInterval: (q) => (q.state.data?.batches.length ? 2000 : false),
	});
	const solidifyBatches = useMemo(() => solidifyOverview?.batches ?? [], [solidifyOverview]);
	// Data source for the inline "solidifying" badge: case ids currently running in any in-flight batch (including batches triggered by others)
	const solidifyRunningCaseIds = useMemo(() => runningCaseIds(solidifyBatches), [solidifyBatches]);
	// The batch I triggered: after completion the batch disappears from the overview, so its terminal state comes from the single-batch endpoint (the overview only returns in-flight batches).
	const { data: solidifyProgress } = useQuery({
		queryKey: ['solidify-batch', solidifyBatchId],
		queryFn: () => api.cases.solidifyBatch(solidifyBatchId!),
		enabled: !!solidifyBatchId,
		refetchInterval: (q) => (q.state.data?.status === 'running' ? 2000 : false),
	});
	// Batch reaches terminal state: summary toast (failures include the first reason) + refresh the case list (solidify column/stepsCompiled have changed)
	useEffect(() => {
		const b = solidifyProgress;
		if (!b || b.status === 'running') return;
		// No repeat announcement after leaving the page/refreshing back: batchIds already reported are recorded in sessionStorage (survives refresh).
		const reportedKey = `itest:solidify-reported:${b.batchId}`;
		if (sessionStorage.getItem(reportedKey)) {
			void setRaw({ solidifyBatchId: null });
			return;
		}
		sessionStorage.setItem(reportedKey, '1');
		const firstFail = b.cases.find((x) => x.status.endsWith('_failed'));
		toast(
			t('groups:batchSolidifyDone', { passed: b.passed, failed: b.failed }) +
				(firstFail?.error ? ` · ${firstFail.title}: ${firstFail.error}` : ''),
			b.status === 'passed' ? 'success' : 'error',
		);
		qc.invalidateQueries({ queryKey: ['cases', projectId] });
		void setRaw({ solidifyBatchId: null });
	}, [solidifyProgress]);

	// status / tag are filtered locally on the frontend (the cases API does not take them); tab and status mean the same thing, so dedupe the two and take the union.
	const filteredCases = useMemo(() => {
		let list = cases ?? [];
		// status filter: tab='all' means no filtering; other tabs are equivalent to a single status selection
		if (tab !== 'all') list = list.filter((c) => c.status === tab);
		if (statusSelected.length > 0) list = list.filter((c) => statusSelected.includes(c.status));
		if (tagSelected.length > 0) list = list.filter((c) => (c.tags ?? []).some((t) => tagSelected.includes(t.id)));
		if (projectsSelected.length > 0) list = list.filter((c) => projectsSelected.includes(c.projectId ?? ''));
		// Group drill-down narrows in the frontend uniformly for both scopes (cases always fetches the full set and never narrows by groupId; see the query comment above)
		if (effectiveGroupId) list = list.filter((c) => c.groupId === effectiveGroupId);
		if (q.trim()) {
			const needle = q.trim().toLowerCase();
			list = list.filter((c) => c.title.toLowerCase().includes(needle));
		}
		return list;
	}, [cases, tab, statusSelected, tagSelected, projectsSelected, onLineScope, effectiveGroupId, q]);

	// "Project" filter options are reverse-derived from the loaded cases, avoiding another request just to get option names
	const projectOptions = useMemo(() => {
		const m = new Map<string, string>();
		for (const c of cases ?? []) {
			if (c.projectId && c.projectName) m.set(c.projectId, c.projectName);
		}
		return [...m.entries()].map(([value, label]) => ({ value, label }));
	}, [cases]);

	// DataTable paginates client-side by default; page size is decided by the URL `?pageSize=`, and rows use the same variable.
	const rows = useMemo(
		() => filteredCases.slice((page - 1) * pageSize, page * pageSize),
		[filteredCases, page, pageSize],
	);
	const total = filteredCases.length;

	// Table bulk selection: ids feed bulk operations; toggleAll = full current page / clear = clear all at once
	const selection = useTableSelection(rows.map((r) => r.id));

	// Clear the selection when switching tabs (avoids cross-tab misselection), keeping the old useEffect behavior
	useEffect(() => { selection.clear(); }, [tab]);

	// Export XMind/Word: no longer an HTTP blob download; uniformly jumps to the AI assistant (rendered by the export-cases skill, delivered as a download card).
	// Selection takes priority (≤500, matching the dump_cases_payload cap); with no selection the scope is the group filter / all cases in the current version, as described.
	const exportViaAssistant = (format: 'xmind' | 'docx') => {
		if (!versionId) return; // line scope has no version workspace, the assistant route does not exist (same fallback as startAiCaseSession)
		const fmt = format === 'xmind' ? 'XMind' : 'Word';
		let initialMessage: string;
		if (selection.ids.length > 0) {
			if (selection.ids.length > 500) {
				toast(t('groups:exportTooMany', { count: selection.ids.length }), 'error');
				return;
			}
			initialMessage = `请把以下 ${selection.ids.length} 条用例导出为 ${fmt} 文档（用例 id：${selection.ids.join('、')}）。`;
		} else {
			if (filteredCases.length === 0) return;
			initialMessage = effectiveGroupId
				? `请把分组「${groupName.get(effectiveGroupId) ?? ''}」（groupId: ${effectiveGroupId}）的用例导出为 ${fmt} 文档。`
				: `请把当前版本的全部用例导出为 ${fmt} 文档。`;
		}
		navigate(`/p/${projectId}/v/${versionId}/assistant`, { state: { initialMessage } });
	};

	const setPriorityFilter = (next: typeof priority) => void setRaw({ priority: next, page: '1' });
	const setScenarioFilter = (next: string) => void setRaw({ scenario: next, page: '1' });
	const setStatusFilter = (next: string[]) => void setRaw({ status: next, page: '1' });
	const setTagFilter = (next: string[]) => void setRaw({ tag: next, page: '1' });
	const setProjectsFilter = (next: string[]) => void setRaw({ projects: next, page: '1' });
	const setScope = (next: typeof scope) => void setRaw({ scope: next, page: '1' });
	// Group tree navigation must carry the current query string: scope and other filter state all live in the search,
	// a bare-path navigate would knock the "product line case library" back to "current version" (hit in practice).
	// Reads window.location instead of useLocation: nuqs shallow updates only call history.replaceState directly,
	// they do not go through router navigate (nuqs dist react-router adapter's updateUrl), so useLocation's search
	// is stale — after switching to the line library via the single-select, clicking a group reads an empty string and scope is still lost.
	// page is the exception — after group narrowing the old page number may be out of range, so it goes back to page 1.
	const goGroup = (gid: string | null) => {
		const sp = new URLSearchParams(window.location.search);
		sp.delete('page');
		const qs = sp.toString();
		navigate({
			pathname: versionId ? `/p/${projectId}/v/${versionId}/groups${gid ? `/${gid}` : ''}` : `/`,
			search: qs ? `?${qs}` : '',
		});
	};
	const setVersionsFilter = (next: string[]) => void setRaw({ versions: next, page: '1' });
	const setSolidifiedFilter = (next: string[]) => void setRaw({ solidified: next, page: '1' });
	const setPage = (next: number) => void setRaw({ page: String(next) });
	const setPageSize = (next: number) => void setRaw({ pageSize: String(next), page: '1' });
	const setTabFilter = (next: typeof tab) => void setRaw({ tab: next, page: '1' });
	const setSearch = (next: string) => void setRaw({ q: next, page: '1' });

	// Search/filter with zero hits must not read as "no cases at all" — the sidebar count and footer total would
	// contradict the empty state and look like data loss (hit in practice). Any active narrowing dimension
	// (client-side q/tab/status/tag/projects/group drill-down, server-side priority/scenario/solidified/versions)
	// flips the table empty state to "no matches" plus a clear-filters entry.
	const hasActiveFilters =
		q.trim() !== '' ||
		tab !== 'all' ||
		effectiveGroupId !== '' ||
		statusSelected.length > 0 ||
		tagSelected.length > 0 ||
		projectsSelected.length > 0 ||
		!!priority ||
		!!scenarioId ||
		solidifiedSelected.length > 0 ||
		(onLineScope && versionsSelected.length > 0);
	// Single navigation instead of setRaw + goGroup: goGroup reads window.location.search, which could race
	// with setRaw's replaceState. Dropping the params returns them to nuqs defaults; scope/pageSize are kept.
	const clearAllFilters = () => {
		const sp = new URLSearchParams(window.location.search);
		for (const key of ['q', 'page', 'tab', 'status', 'tag', 'projects', 'priority', 'scenario', 'solidified', 'versions']) sp.delete(key);
		const qs = sp.toString();
		navigate({
			pathname: versionId ? `/p/${projectId}/v/${versionId}/groups` : `/`,
			search: qs ? `?${qs}` : '',
		});
	};

	const tabs: DataTableTabs = {
		id: 'tab',
		allLabel: t('groups:all'),
		options: [
			{ value: 'draft', label: t('cases:status.draft') },
			{ value: 'review', label: t('cases:status.review') },
			{ value: 'ready', label: t('cases:status.ready') },
			{ value: 'deprecated', label: t('cases:status.deprecated') },
		],
	};

	const facets: DataTableFacet[] = [
		{
			id: 'priority',
			label: t('groups:priority'),
			options: PRIORITY_VALUES.filter((p) => p !== '').map((p) => ({ value: p, label: p })),
		},
		// The "current version" scope is always locked to one version, so this dimension is meaningless there; only line scope uses it to pick baseline cases across versions
		...(onLineScope
			? [{
				id: 'version',
				label: t('groups:version'),
				options: (lineVersions ?? []).map((v) => ({ value: v.id, label: v.name })),
			} as DataTableFacet]
			: []),
		...(onLineScope
			? [{
				id: 'project',
				label: t('groups:projectColumn'),
				options: projectOptions.map((p) => ({ value: p.value, label: p.label })),
			} as DataTableFacet]
			: []),
		{
			id: 'scenario',
			label: t('groups:scenario'),
			options: scenarioOptions.map((o) => ({ value: o.id, label: o.title })),
		},
		{
			id: 'status',
			label: t('groups:statusLabel'),
			options: STATUS_FILTER_VALUES.filter((s) => s !== '').map((s) => ({ value: s, label: t(caseStatusLabel(s)) })),
		},
		{
			id: 'tag',
			label: t('groups:tagLabel'),
			options: (projectTags ?? []).map((t) => ({ value: t.id, label: t.name })),
		},
		{
			id: 'solidified',
			label: t('groups:solidifyLabel'),
			options: [{ value: 'none', label: t('groups:unsolidifiedOnly') }],
		},
	];

	const columnsDef: DataTableColumn<TestCase>[] = [
		{
				id: 'priority',
				header: t('groups:priority'),
				width: 'w-[64px]',
				hideBelow: 'md',
				cell: (c) => <PriorityBadge priority={c.priority} />,
			},
			{
				id: 'title',
				header: t('groups:title'),
				sortable: false,
				// Under table-fixed every other column is percentage/fixed width; without an explicit width the title column only eats the remainder (~10%) and gets squashed;
				// give it an explicit share + a min-w floor (min-width works under table-fixed) so narrow screens squeeze the other truncate columns instead
				width: 'w-[30%] min-w-[240px]',
				cell: (c) => (
					<span className="font-semibold truncate" title={c.title}>{c.title}</span>
				),
				cellClassName: 'min-w-0',
			},
			{
				id: 'group',
				header: t('groups:groupColumn'),
				width: 'w-[10%]',
				hideBelow: 'lg',
				cellClassName: 'text-muted-foreground',
				cell: (c) => (c.groupId ? <span className="truncate">{groupName.get(c.groupId) ?? <EmptyCellValue />}</span> : <EmptyCellValue />),
			},
			{
				id: 'version',
				header: t('groups:version'),
				width: 'w-[7%]',
				hideBelow: 'lg',
				cellClassName: 'text-muted-foreground',
				cell: (c) => (
					<span className="truncate" title={c.versionName ?? undefined}>
						{c.versionName ?? <EmptyCellValue />}
					</span>
				),
			},
			// Solidify progress column: n/n = solidified/total steps; 0/N highlighted as "unsolidified" (the bulk-solidify entry's standard)
			{
				id: 'solidify',
				header: t('groups:solidifyColumn'),
				// Fixed width (not %): the "solidifying" pulse pill is ~63px; a percentage column would be squeezed by the title column down to 58px and truncated
				width: 'w-[92px]',
				hideBelow: 'md',
				cellClassName: 'text-xs text-muted-foreground',
				cell: (c) => {
					// In flight (this row is being solidified in the background) → pulsing "solidifying"; naturally mutually exclusive with "unsolidified" (batches only take fully-unsolidified cases)
					if (solidifyRunningCaseIds.has(c.id)) {
						return (
							<StatusPill tone="accent" pulse>
								<span title={t('groups:solidifyRunningTooltip')}>{t('groups:solidifyRunning')}</span>
							</StatusPill>
						);
					}
					const total = c.stepsTotal ?? 0;
					const compiled = c.stepsCompiled ?? 0;
					if (total === 0) return <EmptyCellValue />;
					if (compiled === 0) {
						return (
							<span
								className="inline-flex items-center rounded font-medium leading-none"
								style={{ background: 'var(--priority-medium-bg)', color: 'var(--priority-medium-text)', fontSize: 10, padding: '2px 6px' }}
								title={t('groups:unsolidified')}
							>
								{t('groups:unsolidified')}
							</span>
						);
					}
					return <span className="tabular-nums">{compiled}/{total}</span>;
				},
			},
			// Under line scope the list mixes projects, so which project a case came from must be shown, otherwise sibling projects' rows are indistinguishable
			...(onLineScope
				? [{
					id: 'project',
					header: t('groups:projectColumn'),
					width: 'w-[9%]',
					hideBelow: 'lg',
					cellClassName: 'text-muted-foreground',
					cell: (c) => (
						<span className="truncate block" title={c.projectName ?? undefined}>
							{c.projectName ?? <EmptyCellValue />}
						</span>
					),
				} as DataTableColumn<TestCase>]
				: []),
			{
				id: 'scenario',
				header: t('groups:scenario'),
				width: 'w-[10%]',
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
				header: t('groups:tagLabel'),
				width: 'w-[12%]',
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
				header: t('groups:statusLabel'),
				width: 'w-[9%]',
				cell: (c) => <CaseStatusMenu caseId={c.id} status={c.status} projectId={projectId} />,
			},
			{
				id: 'createdBy',
				header: t('groups:createdBy'),
				width: 'w-[8%]',
				hideBelow: 'lg',
				cellClassName: 'text-xs text-muted-foreground',
				cell: (c) => (c.createdBy ? <span className="truncate">{creatorName(c.createdBy)}</span> : <EmptyCellValue />),
			},
			{
				id: 'updatedAt',
				header: t('groups:updatedAt'),
				width: 'w-[8%]',
				align: 'right',
				cellClassName: 'text-xs text-muted-foreground tabular-nums',
				cell: (c) => (c.updatedAt ? <span title={c.updatedAt}>{shortDateTime(c.updatedAt)}</span> : <EmptyCellValue />),
			},
			{
				id: 'actions',
				header: '',
				width: 'w-[140px]',
				align: 'right',
				hideable: false,
				cell: (c) => (
					<span
						className="flex items-center justify-end gap-1"
						onClick={(e) => e.stopPropagation()}
					>
						<IconButton
							icon={executeCase.isPending && executeCase.variables === c.id ? 'loader' : 'play'}
							title={t('groups:execute')}
							tone="accent"
							disabled={executeCase.isPending && executeCase.variables === c.id}
							onClick={() => executeCase.mutate(c.id)}
						/>
						<IconButton
							icon="reportView"
							title={t('groups:viewReport')}
							onClick={() => navigate(versionId ? `/p/${projectId}/v/${versionId}/reports?caseId=${c.id}&tab=case` : `/`)}
						/>
						{/* Under line scope, cases already in the current version need no extra copy */}
						{(!onLineScope || c.projectId !== projectId || c.versionId !== versionId) && (
							<IconButton
								icon="copy"
								title={onLineScope ? t('groups:copyToCurrentVersion') : t('groups:copy')}
								onClick={() => { setCopyTarget(''); setCopyModal({ caseIds: [c.id] }); }}
							/>
						)}
						<IconButton
							icon="trash"
							title={t('common:delete')}
							tone="destructive"
							onClick={() => setConfirmDeleteCase({ id: c.id, title: c.title })}
						/>
					</span>
				),
			},
		];

	const startAiCaseSession = useMutation({
		// Jump straight to the space-level AI assistant (/assistant); the first message = requirement body + coverage requirements.
		mutationFn: () => Promise.resolve(),
		onSuccess: () => {
			const initialMessage = aiForm.content + coveragePrompt(aiForm.coverage);
			setAiForm(EMPTY_AI_FORM);
			navigate(versionId ? `/p/${projectId}/v/${versionId}/assistant` : `/`, {
				state: { initialMessage },
			});
		},
		onError: (e: Error) => toast(localizeApiError(e), 'error'),
	});

	// Manual case creation: on success jump to the detail page to continue editing steps
	const createCase = useMutation({
		mutationFn: () =>
			api.cases.create({
				title: caseForm.title.trim(),
				groupId: caseForm.groupId,
				versionId: versionId ?? undefined,
				priority: caseForm.priority,
				description: caseForm.description.trim() || undefined,
			}),
		onSuccess: (r) => {
			toast(t('groups:caseCreated'), 'success');
			setCaseForm(EMPTY_CASE_FORM);
			invalidate();
			navigate(versionId ? `/p/${projectId}/v/${versionId}/cases/${r.id}` : `/`);
		},
		onError: (e: Error) => toast(localizeApiError(e), 'error'),
	});

	return (
		<PageShell contained>
			<PageShellHeader>
				<PageShellTitle>{t('common:navCases')}</PageShellTitle>
				<PageShellDescription>
					{effectiveGroupId ? (groupName.get(effectiveGroupId) ?? t('groups:group')) : t('groups:allCases')} · {current?.name}
				</PageShellDescription>
				<PageShellActions>
					{productLineId && (
						<Segmented
							options={[
								{ value: 'version', label: t('groups:scopeVersion'), icon: 'tag' },
								{ value: 'line', label: t('groups:scopeProductLine'), icon: 'layers' },
							]}
							value={scope}
							onChange={(v) => setScope(v)}
						/>
					)}
					{/* Selection takes priority: with a selection you can export even if the narrowed filter list is empty; without one, disabled only when the current filter result is empty.
					    Export uniformly goes through the AI assistant (export-cases skill); clicking jumps to the assistant page and auto-sends the instruction. */}
					<Button size="sm" variant="ghost" disabled={selection.ids.length === 0 && filteredCases.length === 0} onClick={() => exportViaAssistant('xmind')}>
						<Icon name="download" size={12} />
							{t('groups:exportXmind')}
					</Button>
					<Button size="sm" variant="ghost" disabled={selection.ids.length === 0 && filteredCases.length === 0} onClick={() => exportViaAssistant('docx')}>
						<Icon name="download" size={12} />
							{t('groups:exportWord')}
					</Button>
					<Button
						onClick={() => {
							const gid = effectiveGroupId || groups?.[0]?.id || '';
							setCaseForm({ ...EMPTY_CASE_FORM, open: true, groupId: gid });
						}}
					>
						<Icon name="plus" size={12} />
							{t('groups:newCase')}
					</Button>
					<Button onClick={() => setAiForm({ ...EMPTY_AI_FORM, open: true })}>
						<Icon name="bolt" size={12} />
						{t('groups:aiCreateCase')}
					</Button>
				</PageShellActions>
			</PageShellHeader>

			<PageShellContent className={solidifyBatches.length > 0 ? 'gap-3' : undefined}>
				{/* In-flight batch banner: one per in-flight batch (including ones triggered by others); auto-disappears once the batch reaches a terminal state */}
				{solidifyBatches.map((b) => (
					<div
						key={b.batchId}
						className="rounded-[var(--radius-sm)] px-3 py-2 flex items-center gap-2 text-[11px]"
						style={{
							border: '1px solid var(--border)',
							color: 'var(--primary)',
							background: 'var(--primary-soft)',
						}}
					>
						<Icon name="loader" size={12} className="animate-spin" />
						<span className="font-medium whitespace-nowrap">{t('groups:batchProgressTitle')}</span>
						<span className="whitespace-nowrap">
							{t('groups:batchProgressSummary', { done: b.passed + b.failed, total: b.total })}
						</span>
						{b.failed > 0 && (
							<span className="whitespace-nowrap" style={{ color: 'var(--destructive)' }}>
								{t('groups:batchProgressFailed', { failed: b.failed })}
							</span>
						)}
						<div className="h-1 flex-1 min-w-[60px] rounded-full" style={{ background: 'var(--border)' }}>
							<div
								className="h-1 rounded-full"
								style={{ width: `${batchProgressPercent(b)}%`, background: 'var(--primary)' }}
							/>
						</div>
					</div>
				))}
				<div className="flex flex-1 min-h-0">
					{/* Left group tree */}
					<div
						className="shrink-0 flex flex-col overflow-y-auto"
						style={{ width: 216, borderRight: '1px solid var(--border)', padding: '10px 8px' }}
					>
						<div className="flex items-center justify-between px-2 py-1">
							<span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--muted-foreground)' }}>
								{t('groups:group')}
							</span>
							<button
								title={t('groups:newGroup')}
								onClick={() => setGroupForm({ open: true, mode: 'create', id: null, name: '' })}
								style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--muted-foreground)', padding: 2 }}
							>
								<Icon name="plus" size={13} />
							</button>
						</div>

						<button
							data-active={!effectiveGroupId || undefined}
							onClick={() => goGroup(null)}
							className="group-nav-item text-left px-2 py-1.5 rounded-[var(--radius-sm)] text-[13px]"
							style={{
								color: !effectiveGroupId ? 'var(--primary)' : 'var(--muted-foreground)',
								fontWeight: !effectiveGroupId ? 500 : 400,
								border: 'none', cursor: 'pointer',
							}}
						>
							{t('groups:allCasesCount', { count: cases?.length ?? 0 })}
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
										onClick={() => goGroup(g.id)}
										className="group-nav-item group flex items-center gap-1 px-2 py-1.5 rounded-[var(--radius-sm)] cursor-pointer"
									>
										<Icon name="gitBranch" size={12} style={{ color: 'var(--muted-foreground)', flexShrink: 0 }} />
										<span
											className="flex-1 truncate text-[13px]"
											style={{ color: active ? 'var(--primary)' : 'var(--muted-foreground)', fontWeight: active ? 500 : 400 }}
										>
											{g.name}
										</span>
										<span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{g.caseCount}</span>
										<span className="hidden group-hover:flex items-center" onClick={(e) => e.stopPropagation()}>
											<IconButton
												icon="pencil"
												title={t('groups:renameGroup')}
												onClick={() => setGroupForm({ open: true, mode: 'edit', id: g.id, name: g.name })}
											/>
											<IconButton
												icon="trash"
												title={t('groups:deleteGroup')}
												tone="destructive"
												onClick={() => setConfirmDeleteGroup({ id: g.id, name: g.name })}
											/>
										</span>
									</div>
								);
							})
						)}
					</div>

					{/* Right case table */}
					<div className="flex-1 min-w-0 flex flex-col overflow-hidden p-3">
						{casesError ? (
							<div className="flex flex-1 items-center justify-center text-muted-foreground" style={{ fontSize: 13 }}>
								{t('common:loadFailed')}：{casesErrorObj?.message ?? t('common:unknownError')}
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
											else if (id === 'version') setVersionsFilter(values);
											else if (id === 'project') setProjectsFilter(values);
											else if (id === 'scenario') setScenarioFilter(values[0] ?? '');
											else if (id === 'status') setStatusFilter(values);
											else if (id === 'tag') setTagFilter(values);
											else if (id === 'solidified') setSolidifiedFilter(values);
										},
										filters: {
											priority: priority ? [priority] : [],
											version: versionsSelected,
											project: projectsSelected,
											scenario: scenarioId ? [scenarioId] : [],
											status: statusSelected,
											tag: tagSelected,
											solidified: solidifiedSelected,
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
												{onLineScope ? t('groups:batchCopyToCurrentVersion') : t('groups:batchCopy')}
										</Button>
										<Button size="sm" variant="ghost" onClick={() => { setPlanTarget(''); setPlanModal({ caseIds: selection.ids }); }}>
											<Icon name="play" size={12} />
												{t('groups:addToPlan')}
										</Button>
										<Button size="sm" variant="ghost" onClick={() => setConfirmBatchSolidify(true)}>
											<Icon name="sparkles" size={12} />
												{t('groups:batchSolidify')}
										</Button>
										<select
											aria-label={t('groups:batchStatusAria')}
											className="h-7 rounded-md border border-border bg-background px-2 text-xs outline-none cursor-pointer"
											value=""
											disabled={batchStatus.isPending}
											onChange={(e) => {
												if (e.target.value) batchStatus.mutate(e.target.value as CaseStatus);
											}}
										>
											<option value="">{t('groups:changeStatus')}</option>
											<option value="draft">→ {t('cases:status.draft')}</option>
											<option value="review">→ {t('cases:status.review')}</option>
											<option value="ready">→ {t('cases:status.ready')}</option>
											<option value="deprecated">→ {t('cases:status.deprecated')}</option>
										</select>
										<Button size="sm" variant="destructive" onClick={() => setConfirmBatchDelete(true)}>
											<Icon name="trash" size={12} />
												{t('groups:batchDelete')}
										</Button>
									</>
								) }}
								search={(
									<div className="relative w-full sm:max-w-xs">
										<Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
										<Input
											value={q}
											onChange={(e) => setSearch(e.target.value)}
											placeholder={t('groups:searchPlaceholder')}
											className="pl-7"
											size="sm"
										/>
									</div>
								)}
								empty={
									hasActiveFilters ? (
										<EmptyState
											icon="search"
											title={t('groups:noMatches')}
											description={t('groups:noMatchesHint')}
											action={
												<Button size="sm" variant="ghost" onClick={clearAllFilters}>
													{t('groups:clearFilters')}
												</Button>
											}
										/>
									) : (
										<EmptyState icon="beaker" title={t('groups:noCases')} description={t('groups:noCasesHint')} />
									)
								}
							/>
						)}
					</div>
				</div>
			</PageShellContent>

			{/* Group dialog (create/rename) */}
			<Dialog open={groupForm.open} onOpenChange={(open) => setGroupForm((f) => ({ ...f, open }))}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							{groupForm.mode === 'create' ? t('groups:newGroup') : t('groups:renameGroup')}
						</DialogTitle>
					</DialogHeader>
					<div className="flex flex-col gap-3 px-5 py-4">
						<Input label={t('groups:name')} placeholder={t('groups:namePlaceholder')} value={groupForm.name} onChange={(e) => setGroupForm((f) => ({ ...f, name: e.target.value }))} />
					</div>
					<div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--border)' }}>
						<Button variant="ghost" onClick={() => setGroupForm(EMPTY_GROUP_FORM)}>{t('common:cancel')}</Button>
						<Button
							disabled={!groupForm.name.trim() || saveGroup.isPending}
							onClick={() => saveGroup.mutate()}
						>
							{saveGroup.isPending ? t('groups:saving') : t('common:save')}
						</Button>
					</div>
				</DialogContent>
			</Dialog>

			{/* Delete group confirm */}
			<Dialog open={!!confirmDeleteGroup} onOpenChange={(open) => { if (!open) setConfirmDeleteGroup(null); }}>
				<DialogContent>
					<DialogHeader><DialogTitle>{t('groups:deleteGroup')}</DialogTitle></DialogHeader>
					<div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
						{t('groups:deleteGroupConfirm', { name: confirmDeleteGroup?.name })}
					</div>
					<div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--border)' }}>
						<Button variant="ghost" onClick={() => setConfirmDeleteGroup(null)}>{t('common:cancel')}</Button>
						<Button variant="destructive" disabled={deleteGroup.isPending} onClick={() => confirmDeleteGroup && deleteGroup.mutate(confirmDeleteGroup.id)}>
							{deleteGroup.isPending ? t('groups:deleting') : t('groups:confirmDelete')}
						</Button>
					</div>
				</DialogContent>
			</Dialog>

			{/* Delete case confirm */}
			<Dialog open={!!confirmDeleteCase} onOpenChange={(open) => { if (!open) setConfirmDeleteCase(null); }}>
				<DialogContent>
					<DialogHeader><DialogTitle>{t('groups:deleteCase')}</DialogTitle></DialogHeader>
					<div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
						{t('groups:deleteCaseConfirm', { title: confirmDeleteCase?.title })}
					</div>
					<DialogFooter>
						<Button variant="ghost" onClick={() => setConfirmDeleteCase(null)}>{t('common:cancel')}</Button>
						<Button variant="destructive" disabled={deleteCase.isPending} onClick={() => confirmDeleteCase && deleteCase.mutate(confirmDeleteCase.id)}>
							{deleteCase.isPending ? t('groups:deleting') : t('groups:confirmDelete')}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Bulk delete confirm */}
			<Dialog open={confirmBatchDelete} onOpenChange={(open) => { if (!open) setConfirmBatchDelete(false); }}>
				<DialogContent>
					<DialogHeader><DialogTitle>{t('groups:batchDeleteCases')}</DialogTitle></DialogHeader>
					<div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
						{t('groups:batchDeleteConfirm')} <span style={{ color: 'var(--destructive)', fontWeight: 600 }}>{selection.count}</span> {t('groups:batchDeleteSuffix')}
					</div>
					<DialogFooter>
						<Button variant="ghost" onClick={() => setConfirmBatchDelete(false)}>{t('common:cancel')}</Button>
						<Button
							variant="destructive"
							disabled={batchDeleteCases.isPending || selection.count === 0}
							onClick={() => batchDeleteCases.mutate(selection.ids)}
						>
							{batchDeleteCases.isPending ? t('groups:deleting') : t('groups:batchDeleteButton', { count: selection.count })}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Bulk solidify confirm: AI runs and solidifies case by case + mechanical acceptance, executed in the background */}
			<Dialog open={confirmBatchSolidify} onOpenChange={(open) => { if (!open) setConfirmBatchSolidify(false); }}>
				<DialogContent>
					<DialogHeader><DialogTitle>{t('groups:batchSolidifyTitle')}</DialogTitle></DialogHeader>
					<div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
						{t('groups:batchSolidifyConfirm')} <span style={{ fontWeight: 600, color: 'var(--foreground)' }}>{selection.count}</span> {t('groups:batchSolidifySuffix')}
					</div>
					<DialogFooter>
						<Button variant="ghost" onClick={() => setConfirmBatchSolidify(false)}>{t('common:cancel')}</Button>
						<Button
							disabled={batchSolidifyCases.isPending || selection.count === 0}
							onClick={() => batchSolidifyCases.mutate(selection.ids)}
						>
							{batchSolidifyCases.isPending ? t('groups:batchSolidifyStarting') : t('groups:batchSolidifyButton', { count: selection.count })}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Copy target group dialog */}
			<Dialog open={!!copyModal} onOpenChange={(open) => { if (!open) setCopyModal(null); }}>
				<DialogContent>
					<DialogHeader><DialogTitle>{t('groups:copyCasesTitle', { count: copyModal?.caseIds.length ?? 0 })}</DialogTitle></DialogHeader>
					<div className="flex flex-col gap-3 px-5 py-4">
						<label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-foreground)' }}>{t('groups:targetGroup')}</label>
						<select className="input-base" value={copyTarget} onChange={(e) => setCopyTarget(e.target.value)}>
							<option value="">{t('groups:pleaseSelect')}</option>
							{(groups ?? []).map((g) => (
								<option key={g.id} value={g.id}>{g.name}</option>
							))}
						</select>
						<p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
							{onLineScope
								? t('groups:copyToCurrentVersionHint', { version: current?.versionName ?? versionId ?? '' })
								: t('groups:copyNamingHint')}
						</p>
					</div>
					<DialogFooter>
						<Button variant="ghost" onClick={() => setCopyModal(null)}>{t('common:cancel')}</Button>
						<Button
							disabled={!copyTarget || copyCases.isPending}
							onClick={() => copyModal && copyCases.mutate({ caseIds: copyModal.caseIds, targetGroupId: copyTarget })}
						>
							{copyCases.isPending ? t('groups:copying') : t('groups:copy')}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Add-to-plan dialog */}
			<Dialog open={!!planModal} onOpenChange={(open) => { if (!open) setPlanModal(null); }}>
				<DialogContent>
					<DialogHeader><DialogTitle>{t('groups:addToPlanTitle', { count: planModal?.caseIds.length ?? 0 })}</DialogTitle></DialogHeader>
					<div className="flex flex-col gap-3 px-5 py-4">
						<label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-foreground)' }}>{t('groups:selectPlan')}</label>
						<select className="input-base" value={planTarget} onChange={(e) => setPlanTarget(e.target.value)}>
							<option value="">{t('groups:pleaseSelect')}</option>
							{(plans ?? []).map((p) => (
								<option key={p.id} value={p.id}>{p.name}</option>
							))}
						</select>
						{(plans ?? []).length === 0 && (
							<p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
								{t('groups:noPlansHint')}
							</p>
						)}
					</div>
					<DialogFooter>
						<Button variant="ghost" onClick={() => setPlanModal(null)}>{t('common:cancel')}</Button>
						<Button
							disabled={!planTarget || addToPlan.isPending}
							onClick={() => planModal && addToPlan.mutate({ caseIds: planModal.caseIds, planId: planTarget })}
						>
							{addToPlan.isPending ? t('groups:adding') : t('groups:add')}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* AI create case — collect the requirement title/content, then jump to the AI workbench */}
			<Dialog open={aiForm.open} onOpenChange={(open) => setAiForm((f) => ({ ...f, open }))}>
				<DialogContent>
					<DialogHeader><DialogTitle>{t('groups:aiCreateCase')}</DialogTitle></DialogHeader>
					<div className="flex flex-col gap-3 px-5 py-4">
						<p className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
							{t('groups:aiDialogHint')}
						</p>
						<Input
							label={t('groups:reqTitle')}
							placeholder={t('groups:reqTitlePlaceholder')}
							value={aiForm.title}
							onChange={(e) => setAiForm((f) => ({ ...f, title: e.target.value }))}
						/>
						<div className="flex flex-col gap-1">
							<label className="text-[12px] font-medium" style={{ color: 'var(--muted-foreground)' }}>
								{t('groups:reqDescription')}
							</label>
							<textarea
								className="input-base"
								rows={6}
								placeholder={t('groups:reqDescriptionPlaceholder')}
								value={aiForm.content}
								onChange={(e) => setAiForm((f) => ({ ...f, content: e.target.value }))}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<label className="text-[12px] font-medium" style={{ color: 'var(--muted-foreground)' }}>
								{t('groups:coverageTypeHint')}
							</label>
							<div className="flex flex-wrap gap-x-4 gap-y-1.5">
								{COVERAGE_TYPES.map((ct) => (
									<label key={ct.key} className="flex items-center gap-1.5 text-[13px] cursor-pointer" style={{ color: 'var(--foreground)' }}>
										<input
											type="checkbox"
											checked={aiForm.coverage.includes(ct.key)}
											onChange={() =>
												setAiForm((f) => ({
													...f,
													coverage: f.coverage.includes(ct.key)
														? f.coverage.filter((x) => x !== ct.key)
														: [...f.coverage, ct.key],
												}))
											}
										/>
										{t(`groups:coverage.${ct.key}`)}
									</label>
								))}
							</div>
						</div>
					</div>
					<div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--border)' }}>
						<Button variant="ghost" onClick={() => setAiForm(EMPTY_AI_FORM)}>{t('common:cancel')}</Button>
						<Button
							disabled={!aiForm.title.trim() || !aiForm.content.trim() || startAiCaseSession.isPending}
							onClick={() => startAiCaseSession.mutate()}
						>
							{startAiCaseSession.isPending ? t('groups:opening') : t('groups:startAiSession')}
						</Button>
					</div>
				</DialogContent>
			</Dialog>

			{/* Manual new case */}
			<Dialog open={caseForm.open} onOpenChange={(open) => setCaseForm((f) => ({ ...f, open }))}>
				<DialogContent>
					<DialogHeader><DialogTitle>{t('groups:newCase')}</DialogTitle></DialogHeader>
					<div className="flex flex-col gap-3 px-5 py-4">
						<Input
							label={t('groups:title')}
							placeholder={t('groups:caseTitlePlaceholder')}
							value={caseForm.title}
							onChange={(e) => setCaseForm((f) => ({ ...f, title: e.target.value }))}
						/>
						<div className="flex flex-col gap-1">
							<label className="text-[12px] font-medium" style={{ color: 'var(--muted-foreground)' }}>{t('groups:group')}</label>
							<select
								className="input-base"
								value={caseForm.groupId}
								onChange={(e) => setCaseForm((f) => ({ ...f, groupId: e.target.value }))}
								disabled={(groups ?? []).length === 0}
							>
								{(groups ?? []).length === 0 && <option value="">{t('groups:createGroupFirst')}</option>}
								{(groups ?? []).map((g) => (
									<option key={g.id} value={g.id}>{g.name}</option>
								))}
							</select>
						</div>
						<div className="flex flex-col gap-1">
							<label className="text-[12px] font-medium" style={{ color: 'var(--muted-foreground)' }}>{t('groups:priority')}</label>
							<Segmented
								options={(['P0', 'P1', 'P2', 'P3'] as const).map((p) => ({ value: p, label: p }))}
								value={caseForm.priority}
								onChange={(v) => setCaseForm((f) => ({ ...f, priority: v }))}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<label className="text-[12px] font-medium" style={{ color: 'var(--muted-foreground)' }}>{t('groups:descriptionOptional')}</label>
							<textarea
								className="input-base"
								rows={3}
								placeholder={t('groups:descriptionPlaceholder')}
								value={caseForm.description}
								onChange={(e) => setCaseForm((f) => ({ ...f, description: e.target.value }))}
							/>
						</div>
					</div>
					<div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--border)' }}>
						<Button variant="ghost" onClick={() => setCaseForm(EMPTY_CASE_FORM)}>{t('common:cancel')}</Button>
						<Button
							disabled={!caseForm.title.trim() || !caseForm.groupId || createCase.isPending}
							onClick={() => createCase.mutate()}
						>
							{createCase.isPending ? t('groups:creating') : t('groups:create')}
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</PageShell>
	);
}

