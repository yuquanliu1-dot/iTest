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
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuCheckboxItem, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent,
} from '../components/ui/shadcn/dropdown-menu';
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
  /** 加用例弹窗的目标分组：缺省末组；无组时空串（后端自动建默认分组）。 */
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
  const activeFilterCount = addFilters.groups.length + addFilters.versions.length
    + addFilters.statuses.length + addFilters.priorities.length
    + addFilters.tags.length + addFilters.projects.length;

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
    if (search.trim()) list = list.filter((c) => c.title.includes(search.trim()));
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
    if (showAdd) {
      setSelectedAdd(new Set());
      // 默认加入末组；无组计划留空（后端自动建默认分组）
      setTargetGroupId(plan?.groups.length ? plan.groups[plan.groups.length - 1]!.id : '');
    }
  }, [showAdd, plan]);

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
        <Button variant="ghost" onClick={() => { setShowAdd(true); setAddFilters(EMPTY_ADD_FILTERS); setSearch(''); }}>
          <Icon name="plus" size={12} />
          {t('plans:addCases')}
        </Button>
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
                />
              ))}
            </div>
          )}
        </div>
        </div>
      </div>

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent style={{ maxWidth: 600 }}>
          <DialogHeader>
            <DialogTitle>{t('plans:addCases')}</DialogTitle>
          </DialogHeader>
          <div className="px-5 py-3 flex items-center gap-2">
            <div className="input-wrap flex-1 min-w-0">
              <Icon name="search" size={14} className="input-icon" />
              <input
                type="text"
                placeholder={t('plans:searchCase')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="input-base input-sm input-with-leading"
              />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="shrink-0">
                  <Icon name="settings" size={12} />
                  {t('plans:filter')}
                  {activeFilterCount > 0 && (
                    <span className="text-[11px] tabular-nums opacity-70">({activeFilterCount})</span>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-52">
                {activeFilterCount > 0 && (
                  <>
                    <DropdownMenuItem onSelect={() => setAddFilters(EMPTY_ADD_FILTERS)}>
                      {t('plans:clearAllFilters')}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                <FilterSubmenu
                  label={t('groups:group')}
                  options={(projectGroups ?? []).map((g) => ({ value: g.id, label: g.name }))}
                  selected={addFilters.groups}
                  onChange={(v) => setAddFilters({ ...addFilters, groups: v })}
                />
                <FilterSubmenu
                  label={t('groups:version')}
                  options={(projectVersions ?? []).map((v) => ({ value: v.id, label: v.name }))}
                  selected={addFilters.versions}
                  onChange={(v) => setAddFilters({ ...addFilters, versions: v })}
                />
                {/* 产品线项目才需要「项目」维度：未归线时池子里只有本项目用例，这一维恒为单值 */}
                {productLineId && projectOptions.length > 1 && (
                  <FilterSubmenu
                    label={t('productLines:project')}
                    options={projectOptions}
                    selected={addFilters.projects}
                    onChange={(v) => setAddFilters({ ...addFilters, projects: v })}
                  />
                )}
                <FilterSubmenu
                  label={t('groups:statusLabel')}
                  options={(['draft', 'review', 'ready', 'deprecated'] as const).map((s) => ({ value: s, label: t(caseStatusLabel(s)) }))}
                  selected={addFilters.statuses}
                  onChange={(v) => setAddFilters({ ...addFilters, statuses: v })}
                />
                <FilterSubmenu
                  label={t('groups:priority')}
                  options={['P0', 'P1', 'P2', 'P3'].map((p) => ({ value: p, label: p }))}
                  selected={addFilters.priorities}
                  onChange={(v) => setAddFilters({ ...addFilters, priorities: v })}
                />
                <FilterSubmenu
                  label={t('groups:tagLabel')}
                  options={(projectTags ?? []).map((t) => ({ value: t.id, label: t.name }))}
                  selected={addFilters.tags}
                  onChange={(v) => setAddFilters({ ...addFilters, tags: v })}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="px-5 pb-2 flex items-center gap-2">
            <span className="text-[12px] shrink-0" style={{ color: 'var(--muted-foreground)' }}>{t('plans:targetGroup')}</span>
            <select
              value={targetGroupId}
              onChange={(e) => setTargetGroupId(e.target.value)}
              className="input-base input-sm flex-1"
              style={{ minWidth: 200 }}
            >
              {plan.groups.length === 0 ? (
                <option value="">{t('plans:newGroupName')}</option>
              ) : (
                plan.groups.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))
              )}
            </select>
          </div>
          <div className="px-5 pb-4 max-h-[400px] overflow-y-auto flex flex-col gap-1">
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
            <span className="text-[12px] mr-auto" style={{ color: 'var(--muted-foreground)' }}>{t('plans:selectedCount', { count: selectedAdd.size })}</span>
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

/** 添加用例弹窗过滤菜单的单个维度子菜单（镜像 DataTable FacetSubmenu 交互）：
 *  父菜单「过滤」内 hover 展开，checkbox 多选；options 空 → 禁选「无可选项」；有选中 → 顶部「清除」一键清空该维。 */
function FilterSubmenu({
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
  const active = selected.length > 0;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        {label}
        {active ? ` (${selected.length})` : ''}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-72 min-w-52 overflow-y-auto">
        {options.length === 0 ? (
          <DropdownMenuItem disabled>{t('common:noOptions')}</DropdownMenuItem>
        ) : (
          <>
            {active && (
              <>
                <DropdownMenuItem onSelect={() => onChange([])}>{t('plans:clear')}</DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            {options.map((o) => (
              <DropdownMenuCheckboxItem
                key={o.value}
                checked={selected.includes(o.value)}
                onCheckedChange={(next) => onChange(next === true ? [...selected, o.value] : selected.filter((v) => v !== o.value))}
              >
                {o.label}
              </DropdownMenuCheckboxItem>
            ))}
          </>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
