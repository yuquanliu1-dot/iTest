import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { localizeApiError } from '../i18n';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import StatusPill from '../components/ui/StatusPill';
import EmptyState from '../components/ui/EmptyState';
import Button from '../components/ui/Button';
import InlineEdit from '../components/ui/InlineEdit';
import ScheduleListCard from '../components/plans/ScheduleListCard';
import PlanGroupCard from '../components/plans/PlanGroupCard';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/Modal';
import { Popover, PopoverTrigger, PopoverContent } from '../components/ui/shadcn/popover';
import { caseStatusLabel } from '../lib/format';
import { creatorName } from '../lib/creatorName';

type Strategy = 'run_all' | 'fail_fast';

/** 添加用例弹窗的过滤选中集：每维一组 value（多选并集）。 */
type AddFilters = {
  groups: string[];
  versions: string[];
  statuses: string[];
  priorities: string[];
  tags: string[];
  projects: string[];
};

export default function PlanDetail() {
  const { id, projectId, versionId: vidParam } = useParams<{ id: string; projectId: string; versionId?: string }>();
  const versionId = vidParam ?? null;
  const navigate = useNavigate();
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();

  const { data: plan, isError, error } = useQuery({
    queryKey: ['plan', id],
    queryFn: () => api.plans.get(id!),
    enabled: !!id,
  });

  const [showAdd, setShowAdd] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [selectedAdd, setSelectedAdd] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  /** 加用例弹窗的目标分组：由打开入口锁定（组卡按钮=本组；无组计划走顶部按钮=后端自动建默认分组）。 */
  const [targetGroupId, setTargetGroupId] = useState('');

  /** 计划所属项目的归属信息：决定用例池是否跨产品线取（未归线的项目池子与现状完全一致）。 */
  const { data: planProject } = useQuery({
    queryKey: ['project', plan?.projectId],
    queryFn: () => api.projects.get(plan!.projectId),
    enabled: !!plan?.projectId,
  });
  const productLineId = planProject?.productLineId ?? null;

  const { data: allCases } = useQuery({
    queryKey: ['cases', productLineId ? 'line' : 'proj', productLineId ?? projectId],
    queryFn: () =>
      productLineId
        ? api.cases.list({ productLineId })
        : api.cases.list({ projectId }),
    enabled: !!projectId,
  });

  /** 添加用例弹窗的过滤维度选项：分组名 / 版本名 / 标签名靠三处 GET 提供（值与选中集在前端本地筛）。
   *  产品线项目下改取线内跨项目的分组/版本，否则筛选菜单只有本项目的选项。 */
  const { data: projectGroups } = useQuery({
    queryKey: ['groups', productLineId ?? projectId],
    queryFn: () =>
      productLineId
        ? api.projects.groupsByProductLine(productLineId)
        : api.projects.groups(projectId!),
    enabled: !!projectId,
  });
  const { data: projectVersions } = useQuery({
    queryKey: ['versions', productLineId ?? projectId],
    queryFn: () =>
      productLineId
        ? api.projects.versionsByProductLine(productLineId)
        : api.versions.list(projectId!),
    enabled: !!projectId,
  });
  const { data: projectTags } = useQuery({
    queryKey: ['tags', projectId],
    queryFn: () => api.tags.list(projectId!),
    enabled: !!projectId,
  });

  /** 添加用例弹窗过滤：每维多选（并集），维度间取交集。弹窗每次打开重置为空。 */
  const EMPTY_ADD_FILTERS: AddFilters = { groups: [], versions: [], statuses: [], priorities: [], tags: [], projects: [] };
  const [addFilters, setAddFilters] = useState<AddFilters>(EMPTY_ADD_FILTERS);
  const hasAddFilter = addFilters.groups.length > 0 || addFilters.versions.length > 0
    || addFilters.statuses.length > 0 || addFilters.priorities.length > 0 || addFilters.tags.length > 0
    || addFilters.projects.length > 0;

  /** 已在计划的用例 id：候选不再过滤（跨组重复合法），仅在行尾标「已在计划」。 */
  const inPlanIds = useMemo(() => new Set((plan?.cases ?? []).map((c) => c.id)), [plan]);
  const candidates = useMemo(() => {
    let list = [...(allCases ?? [])];
    // 状态/标签走前端本地筛（GET /cases 不接这两个参数，与 GroupsPage 一致）
    if (addFilters.groups.length) list = list.filter((c) => addFilters.groups.includes(c.groupId ?? ''));
    if (addFilters.versions.length) list = list.filter((c) => c.versionId != null && addFilters.versions.includes(c.versionId));
    if (addFilters.projects.length) list = list.filter((c) => addFilters.projects.includes(c.projectId ?? ''));
    if (addFilters.statuses.length) list = list.filter((c) => addFilters.statuses.includes(c.status));
    if (addFilters.priorities.length) list = list.filter((c) => addFilters.priorities.includes(c.priority));
    if (addFilters.tags.length) list = list.filter((c) => (c.tags ?? []).some((t) => addFilters.tags.includes(t.id)));
    // 搜索：大小写不敏感，标题或标签名命中任一即保留
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((c) => c.title.toLowerCase().includes(q) || (c.tags ?? []).some((tg) => tg.name.toLowerCase().includes(q)));
    return list;
  }, [allCases, addFilters, search]);

  /** 产品线项目下的「项目」筛选项：从候选池反推，避免多发一次 GET。 */
  const projectOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of allCases ?? []) {
      if (c.projectId && c.projectName) m.set(c.projectId, c.projectName);
    }
    return [...m.entries()].map(([value, label]) => ({ value, label }));
  }, [allCases]);

  /** 筛选维度描述：维度按钮行与 chips 行共用一份（顺序即按钮顺序：分组/项目/版本/标签/优先级/状态）。 */
  const filterDimensions: Array<{ key: keyof AddFilters; label: string; options: Array<{ value: string; label: string }> }> = [
    { key: 'groups', label: t('groups:group'), options: (projectGroups ?? []).map((g) => ({ value: g.id, label: g.name })) },
    // 产品线项目才需要「项目」维度：未归线时池子里只有本项目用例，这一维恒为单值
    ...(productLineId && projectOptions.length > 1
      ? [{ key: 'projects' as const, label: t('productLines:project'), options: projectOptions }]
      : []),
    { key: 'versions', label: t('groups:version'), options: (projectVersions ?? []).map((v) => ({ value: v.id, label: v.name })) },
    { key: 'tags', label: t('groups:tagLabel'), options: (projectTags ?? []).map((tag) => ({ value: tag.id, label: tag.name })) },
    { key: 'priorities', label: t('groups:priority'), options: ['P0', 'P1', 'P2', 'P3'].map((p) => ({ value: p, label: p })) },
    { key: 'statuses', label: t('groups:statusLabel'), options: (['draft', 'review', 'ready', 'deprecated'] as const).map((s) => ({ value: s, label: t(caseStatusLabel(s)) })) },
  ];

  /** 全选筛选结果：勾=并入当前筛选命中的全部 id；取消=只移除可见 id（隐藏项的选择保留）。 */
  const visibleSelectedCount = candidates.reduce((n, c) => n + (selectedAdd.has(c.id) ? 1 : 0), 0);
  const allCandidatesSelected = candidates.length > 0 && visibleSelectedCount === candidates.length;
  const someCandidatesSelected = visibleSelectedCount > 0 && !allCandidatesSelected;
  const toggleSelectAllCandidates = () => {
    const next = new Set(selectedAdd);
    if (allCandidatesSelected) candidates.forEach((c) => next.delete(c.id));
    else candidates.forEach((c) => next.add(c.id));
    setSelectedAdd(next);
  };

  /** 登录准备候选：任一组启用登录准备才需要（组卡内本地按标题过滤）。 */
  const { data: loginCases } = useQuery({
    queryKey: ['plan', id, 'login-cases'],
    queryFn: () => api.plans.loginCases(id!),
    enabled: !!id && (plan?.groups ?? []).some((g) => g.loginPrepareEnabled),
  });

  const { data: environments } = useQuery({
    queryKey: ['environments', plan?.projectId],
    queryFn: () => api.environments.list(plan!.projectId),
    enabled: !!plan?.projectId,
  });

  const invalidatePlan = () => {
    qc.invalidateQueries({ queryKey: ['plan', id] });
    qc.invalidateQueries({ queryKey: ['plans', projectId] });
  };

  const patchPlan = useMutation({
    mutationFn: (body: Parameters<typeof api.plans.patch>[1]) => api.plans.patch(id!, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plan', id] });
      qc.invalidateQueries({ queryKey: ['plans', projectId] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const createGroup = useMutation({
    mutationFn: () => api.plans.createGroup(id!, { name: t('plans:newGroupName') }),
    onSuccess: invalidatePlan,
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const addCases = useMutation({
    mutationFn: (vars: { caseIds: string[]; groupId?: string }) => api.plans.addCases(id!, vars.caseIds, vars.groupId),
    onSuccess: () => {
      toast(t('plans:casesUpdated'), 'success');
      invalidatePlan();
      setShowAdd(false);
      setSelectedAdd(new Set());
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const remove = useMutation({
    mutationFn: () => api.plans.remove(id!),
    onSuccess: () => {
      toast(t('plans:deletedToast'), 'success');
      qc.invalidateQueries({ queryKey: ['plans', projectId] });
      navigate(versionId ? `/p/${projectId}/v/${versionId}/plans` : `/`);
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const run = useMutation({
    mutationFn: () => api.plans.run(id!),
    onSuccess: (r) => {
      // 执行即跳运行详情页：running 中实时画面 + 2s 轮询到完成，中止按钮在 PlanRunDetail 内。
      qc.invalidateQueries({ queryKey: ['executions'] });
      navigate(versionId ? `/p/${projectId}/v/${versionId}/plans/${id}/runs/${r.runId}` : `/`);
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  useEffect(() => {
    // 目标分组由打开入口决定（组卡按钮=本组；无组计划走顶部按钮=后端自动建默认分组）
    if (showAdd) setSelectedAdd(new Set());
  }, [showAdd]);

  if (isError) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--muted-foreground)', fontSize: 13 }}>
        {t('common:loadFailed')}：{error?.message ?? t('common:unknownError')}
      </div>
    );
  }

  if (!plan) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--muted-foreground)' }}>
        <Icon name="loader" size={16} className="animate-spin" />
        <span style={{ marginLeft: 8 }}>{t('cases:loading')}</span>
      </div>
    );
  }

  const updateStrategy = (v: Strategy) => patchPlan.mutate({ strategy: v });

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 px-6 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(versionId ? `/p/${projectId}/v/${versionId}/plans` : `/`)}
        >
          <Icon name="chevronLeft" size={12} />
          {t('plans:backToList')}
        </Button>
        <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
        {/* 计划名称行内可编辑：点标题改，走 PATCH /plans/:id { name } */}
        <InlineEdit
          value={plan.name}
          disabled={patchPlan.isPending}
          ariaLabel={t('plans:planNameAria')}
          onSave={(next) => patchPlan.mutateAsync({ name: next })}
          className="text-[16px] font-semibold max-w-[420px]"
          inputClassName="text-[16px] font-semibold max-w-[420px]"
          style={{ color: 'var(--foreground)' }}
        />
        {plan.versionId && plan.versionName ? (
          <span
            className="text-[10px] font-semibold uppercase px-2 py-[2px] rounded-full"
            style={{ background: 'var(--primary-soft)', color: 'var(--primary)', letterSpacing: '0.04em' }}
            title={t('plans:belongsVersion')}
          >
            {plan.versionName}
          </span>
        ) : null}
        <div className="flex-1" />
        <Button variant="ghost" disabled={createGroup.isPending} onClick={() => createGroup.mutate()}>
          <Icon name="plus" size={12} />
          {t('plans:addGroup')}
        </Button>
        {/* 有分组时添加入口在各组卡内；顶部按钮仅无组计划保留（后端自动建默认分组） */}
        {plan.groups.length === 0 && (
          <Button variant="ghost" onClick={() => { setTargetGroupId(''); setAddFilters(EMPTY_ADD_FILTERS); setSearch(''); setShowAdd(true); }}>
            <Icon name="plus" size={12} />
            {t('plans:addCases')}
          </Button>
        )}
        <Button onClick={() => run.mutate()} disabled={run.isPending || plan.cases.length === 0}>
          <Icon name="play" size={12} />
          {run.isPending ? t('plans:starting') : t('plans:runOnce')}
        </Button>
        <Button
          variant="ghost"
          onClick={() => setShowDelete(true)}
          style={{ color: 'var(--destructive)' }}
          aria-label={t('plans:deletePlanTitle')}
          title={t('plans:deletePlanTitle')}
        >
          <Icon name="trash" size={12} />
        </Button>
      </div>

      {/* 滚动容器全宽（滚动条贴视口右缘），clamp 限宽居中放内层——同 PageShell 的 scroll/clamp 两层结构，
          clamp 放滚动层上会让滚动条悬在限宽容器边缘而不是屏幕最右 */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-6 flex flex-col gap-4 mx-auto w-full max-w-[min(100%-2rem,100rem)]">
        <div className="bg-card border rounded-[var(--radius-md)] p-5">
          {/* input-base 默认 width:100%，flex 行内会把标签挤到竖排；控件 flex-1 弹性填充 + 标签 shrink-0 */}
          <div className="flex items-center gap-4">
            <span className="text-[12px] shrink-0" style={{ color: 'var(--muted-foreground)' }}>{t('plans:strategy')}</span>
            <select
              value={plan.strategy}
              onChange={(e) => updateStrategy(e.target.value as Strategy)}
              className="input-base input-sm flex-1"
              style={{ minWidth: 160, maxWidth: 240 }}
            >
              <option value="run_all">{t('plans:strategyRunAll')}</option>
              <option value="fail_fast">{t('plans:strategyFailFast')}</option>
            </select>
          </div>
          <div className="mt-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('plans:strategyHint')}</div>
          <div className="mt-4">
            <div className="hairline-top pt-3">
              <label className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
                <input
                  type="checkbox"
                  checked={plan.rcaEnabled ?? false}
                  disabled={patchPlan.isPending}
                  onChange={(e) => patchPlan.mutate({ rcaEnabled: e.target.checked })}
                />
                {t('plans:enableRca')}
              </label>
              <div className="mt-1 pl-6 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('plans:enableRcaHint')}</div>
            </div>
          </div>
          <div className="mt-4 hairline-top pt-3 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
            {t('groups:createdBy')} {creatorName(plan.createdBy)}
          </div>
        </div>

        <ScheduleListCard planId={id!} />

        <div className="bg-card border rounded-[var(--radius-md)] p-5">
          <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-3 hairline-bottom pb-2" style={{ color: 'var(--muted-foreground)' }}>
            {t('plans:caseOrder', { count: plan.cases.length })}
          </div>
          {plan.groups.length === 0 ? (
            <EmptyState
              icon="flag"
              title={t('plans:noGroups')}
              description={t('plans:noGroupsHint')}
              action={
                <Button size="sm" disabled={createGroup.isPending} onClick={() => createGroup.mutate()}>
                  + {t('plans:addGroup')}
                </Button>
              }
            />
          ) : (
            <div className="flex flex-col gap-4">
              {plan.groups.map((g) => (
                <PlanGroupCard
                  key={g.id}
                  plan={plan}
                  group={g}
                  groups={plan.groups}
                  environments={environments ?? []}
                  loginCases={loginCases ?? []}
                  onInvalidate={invalidatePlan}
                  onAddCases={() => { setTargetGroupId(g.id); setAddFilters(EMPTY_ADD_FILTERS); setSearch(''); setShowAdd(true); }}
                />
              ))}
            </div>
          )}
        </div>
        </div>
      </div>

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent style={{ maxWidth: 720 }}>
          <DialogHeader>
            <DialogTitle>{t('plans:addCases')}</DialogTitle>
          </DialogHeader>
          <div className="px-5 py-3">
            <div className="input-wrap">
              <Icon name="search" size={14} className="input-icon" />
              <input
                type="text"
                autoFocus
                placeholder={t('plans:searchCase')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="input-base input-sm input-with-leading"
              />
            </div>
            {/* 维度按钮行：每个维度单击展开扁平多选，勾选不关弹层 */}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {filterDimensions.map((d) => (
                <DimensionPicker
                  key={d.key}
                  label={d.label}
                  options={d.options}
                  selected={addFilters[d.key]}
                  onChange={(v) => setAddFilters({ ...addFilters, [d.key]: v })}
                />
              ))}
            </div>
            {/* 激活条件 chips：一眼可见、逐个可删；搜索词也是一枚 chip */}
            {(hasAddFilter || search.trim()) && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {filterDimensions.flatMap((d) =>
                  addFilters[d.key].map((v) => (
                    <FilterChip
                      key={`${d.key}:${v}`}
                      label={t('plans:chipLabel', { dim: d.label, value: d.options.find((o) => o.value === v)?.label ?? v })}
                      onRemove={() => setAddFilters({ ...addFilters, [d.key]: addFilters[d.key].filter((x) => x !== v) })}
                    />
                  )),
                )}
                {search.trim() && (
                  <FilterChip
                    label={t('plans:chipLabel', { dim: t('plans:searchKeyword'), value: search.trim() })}
                    onRemove={() => setSearch('')}
                  />
                )}
                <button
                  type="button"
                  className="press inline-flex items-center text-[12px] hover:underline shrink-0"
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--primary)' }}
                  onClick={() => { setAddFilters(EMPTY_ADD_FILTERS); setSearch(''); }}
                >
                  {t('plans:clearAll')}
                </button>
              </div>
            )}
          </div>
          <div className="px-5 pb-4 max-h-[400px] overflow-y-auto flex flex-col gap-1">
            {/* 全选筛选结果：含「已在计划」/deprecated 行（跨组重复合法，与手点一致） */}
            {candidates.length > 0 && (
              <div
                className="sticky top-0 z-10 flex items-center gap-2 px-3 py-2 hairline-bottom"
                style={{ background: 'var(--popover)' }}
              >
                <input
                  type="checkbox"
                  checked={allCandidatesSelected}
                  ref={(el) => { if (el) el.indeterminate = someCandidatesSelected; }}
                  onChange={toggleSelectAllCandidates}
                  aria-label={t('plans:selectAllFiltered', { count: candidates.length })}
                />
                <span className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
                  {t('plans:selectAllFiltered', { count: candidates.length })}
                </span>
              </div>
            )}
            {candidates.length === 0 ? (
              <div className="text-[12px] py-8 text-center" style={{ color: 'var(--muted-foreground)' }}>
                {hasAddFilter || search.trim() ? t('plans:noMatchingCases') : t('plans:noAddableCases')}
              </div>
            ) : (
              candidates.map((c) => {
                const checked = selectedAdd.has(c.id);
                const inPlan = inPlanIds.has(c.id);
                return (
                  <div
                    key={c.id}
                    className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius-sm)] cursor-pointer hover-card"
                    style={{ opacity: c.status === 'deprecated' ? 0.55 : 1 }}
                    onClick={() => {
                      const next = new Set(selectedAdd);
                      if (checked) next.delete(c.id);
                      else next.add(c.id);
                      setSelectedAdd(next);
                    }}
                  >
                    <input type="checkbox" readOnly checked={checked} />
                    <span className="text-[12px] flex-1 truncate" style={{ color: 'var(--foreground)' }}>{c.title}</span>
                    {/* 跨组重复合法：已在计划的候选仍可勾选（加入其他分组），仅提示不拦 */}
                    {inPlan && (
                      <span
                        className="text-[10px] font-semibold px-1.5 py-[1px] rounded shrink-0"
                        style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}
                      >
                        {t('plans:alreadyInPlan')}
                      </span>
                    )}
                    {/* 跨项目候选行标出来源项目，避免用户在计划里混进自己没注意的兄弟项目用例 */}
                    {productLineId && c.projectId && c.projectId !== projectId && (
                      <span
                        className="text-[10px] font-semibold px-1.5 py-[1px] rounded shrink-0"
                        style={{ background: 'var(--primary-soft, var(--muted))', color: 'var(--primary, var(--foreground))' }}
                        title={t('plans:caseFromProject', { project: c.projectName ?? '' })}
                      >
                        {c.projectName}
                      </span>
                    )}
                    {c.status === 'deprecated' && (
                      <StatusPill status={c.status}>{t(caseStatusLabel(c.status))}</StatusPill>
                    )}
                    <span className="text-[10px]" style={{ color: 'var(--muted-foreground)' }}>{c.priority}</span>
                  </div>
                );
              })
            )}
          </div>
          <DialogFooter>
            <span className="text-[12px] mr-auto flex items-center gap-2" style={{ color: 'var(--muted-foreground)' }}>
              {t('plans:selectedCount', { count: selectedAdd.size })}
              {/* 目标分组由打开入口锁定（组卡按钮），此处仅展示去向 */}
              {t('plans:targetGroup')}
              <span className="font-semibold" style={{ color: 'var(--foreground)' }}>
                {plan.groups.find((g) => g.id === targetGroupId)?.name ?? t('plans:newGroupName')}
              </span>
            </span>
            <Button variant="ghost" onClick={() => setShowAdd(false)}>{t('common:cancel')}</Button>
            <Button
              disabled={selectedAdd.size === 0}
              onClick={() => {
                addCases.mutate({ caseIds: Array.from(selectedAdd), groupId: targetGroupId || undefined });
              }}
            >
              {t('groups:addToPlan')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showDelete} onOpenChange={setShowDelete}>
        <DialogContent style={{ maxWidth: 420 }}>
          <DialogHeader>
            <DialogTitle>{t('plans:deletePlanTitle')}</DialogTitle>
          </DialogHeader>
          <div className="px-5 py-4 flex flex-col gap-2">
            <p className="text-[13px]" style={{ color: 'var(--foreground)' }}>
              {t('plans:deletePlanConfirm', { name: plan.name })}
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowDelete(false)}>{t('common:cancel')}</Button>
            <Button
              onClick={() => {
                setShowDelete(false);
                remove.mutate();
              }}
              disabled={remove.isPending}
              style={{ background: 'var(--destructive)', color: '#fff', border: 'none' }}
            >
              {remove.isPending ? t('cases:deleting') : t('cases:confirmDelete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 添加用例弹窗的单维度筛选器：单击展开的扁平多选 Popover（勾选不关弹层；>8 项带迷你搜索）。
 *  触发器三态：未选=维度名；单选=「维度 · 选项名」；多选=「维度 · N 项」。 */
function DimensionPicker({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: Array<{ value: string; label: string }>;
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const keyword = q.trim().toLowerCase();
  const visibleOptions = keyword
    ? options.filter((o) => o.label.toLowerCase().includes(keyword))
    : options;
  const triggerLabel = selected.length === 0
    ? label
    : selected.length === 1
      ? `${label} · ${options.find((o) => o.value === selected[0])?.label ?? ''}`
      : `${label} · ${t('plans:nItems', { count: selected.length })}`;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQ('');
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={options.length === 0}
          className={selected.length > 0 ? 'bg-primary/10 text-primary' : undefined}
        >
          <span className="truncate max-w-[140px]">{triggerLabel}</span>
          <Icon name="chevronDown" size={12} className="shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2 gap-1">
        {options.length > 8 && (
          <div className="input-wrap">
            <Icon name="search" size={12} className="input-icon" />
            <input
              type="text"
              autoFocus
              placeholder={t('plans:searchInOptions')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="input-base input-sm input-with-leading"
            />
          </div>
        )}
        <div className="max-h-64 overflow-y-auto flex flex-col">
          {visibleOptions.length === 0 ? (
            <div className="text-[12px] px-2 py-3 text-center" style={{ color: 'var(--muted-foreground)' }}>
              {t('plans:noMatchInOptions')}
            </div>
          ) : (
            visibleOptions.map((o) => {
              const checked = selected.includes(o.value);
              return (
                <label
                  key={o.value}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-sm)] cursor-pointer hover-card"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      onChange(checked ? selected.filter((v) => v !== o.value) : [...selected, o.value])
                    }
                  />
                  <span className="text-[12px] truncate" style={{ color: 'var(--foreground)' }}>{o.label}</span>
                </label>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** 激活筛选条件 chip：中性底色 + × 单击移除（镜像 TagChip 结构，但不绑定标签色）。 */
function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  const { t } = useTranslation();
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full font-medium"
      style={{ background: 'var(--muted)', color: 'var(--foreground)', padding: '2px 8px', fontSize: 12, lineHeight: 1.4 }}
    >
      <span className="truncate max-w-[160px]">{label}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        aria-label={t('plans:removeFilterChip', { label })}
        className="inline-flex items-center justify-center"
        style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, color: 'inherit', opacity: 0.7 }}
      >
        <Icon name="close" size={10} />
      </button>
    </span>
  );
}
