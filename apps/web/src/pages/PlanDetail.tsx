import { useEffect, useMemo, useRef, useState } from 'react';
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
import IconButton from '../components/ui/IconButton';
import InlineEdit from '../components/ui/InlineEdit';
import ScheduleListCard from '../components/plans/ScheduleListCard';
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
  /** 用例移除确认弹窗:点击行内 🗑 时弹出,避免误点(执行计划不含跨域层级,误移易踩雷)。 */
  const [confirmRemoveCase, setConfirmRemoveCase] = useState<{ id: string; title: string } | null>(null);
  const [selectedAdd, setSelectedAdd] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [environmentId, setEnvironmentId] = useState<string | null>(null);

  const { data: allCases } = useQuery({
    queryKey: ['cases', projectId, versionId],
    queryFn: () => api.cases.list({ projectId }),
    enabled: !!projectId,
  });

  /** 添加用例弹窗的过滤维度选项：分组名 / 版本名 / 标签名靠三处 GET 提供（值与选中集在前端本地筛）。 */
  const { data: projectGroups } = useQuery({
    queryKey: ['groups', projectId],
    queryFn: () => api.projects.groups(projectId!),
    enabled: !!projectId,
  });
  const { data: projectVersions } = useQuery({
    queryKey: ['versions', projectId],
    queryFn: () => api.versions.list(projectId!),
    enabled: !!projectId,
  });
  const { data: projectTags } = useQuery({
    queryKey: ['tags', projectId],
    queryFn: () => api.tags.list(projectId!),
    enabled: !!projectId,
  });

  /** 添加用例弹窗过滤：每维多选（并集），维度间取交集。弹窗每次打开重置为空。 */
  const EMPTY_ADD_FILTERS: AddFilters = { groups: [], versions: [], statuses: [], priorities: [], tags: [] };
  const [addFilters, setAddFilters] = useState<AddFilters>(EMPTY_ADD_FILTERS);
  const hasAddFilter = addFilters.groups.length > 0 || addFilters.versions.length > 0
    || addFilters.statuses.length > 0 || addFilters.priorities.length > 0 || addFilters.tags.length > 0;
  const activeFilterCount = addFilters.groups.length + addFilters.versions.length
    + addFilters.statuses.length + addFilters.priorities.length + addFilters.tags.length;

  const inPlanIds = useMemo(() => new Set((plan?.cases ?? []).map((c) => c.id)), [plan]);
  const candidates = useMemo(() => {
    let list = (allCases ?? []).filter((c) => !inPlanIds.has(c.id));
    // 状态/标签走前端本地筛（GET /cases 不接这两个参数，与 GroupsPage 一致）
    if (addFilters.groups.length) list = list.filter((c) => addFilters.groups.includes(c.groupId ?? ''));
    if (addFilters.versions.length) list = list.filter((c) => c.versionId != null && addFilters.versions.includes(c.versionId));
    if (addFilters.statuses.length) list = list.filter((c) => addFilters.statuses.includes(c.status));
    if (addFilters.priorities.length) list = list.filter((c) => addFilters.priorities.includes(c.priority));
    if (addFilters.tags.length) list = list.filter((c) => (c.tags ?? []).some((t) => addFilters.tags.includes(t.id)));
    if (search.trim()) list = list.filter((c) => c.title.includes(search.trim()));
    return list;
  }, [allCases, inPlanIds, addFilters, search]);

  const [loginQ, setLoginQ] = useState('');
  const { data: loginCases } = useQuery({
    queryKey: ['plan', id, 'login-cases', loginQ],
    queryFn: () => api.plans.loginCases(id!, loginQ),
    enabled: !!id && (plan?.loginPrepareEnabled ?? false),
  });

  const { data: environments } = useQuery({
    queryKey: ['environments', plan?.projectId],
    queryFn: () => api.environments.list(plan!.projectId),
    enabled: !!plan?.projectId,
  });

  // plan 重新加载时同步 serverValue；本地未保存改动时（如保存其他字段）避免被覆盖
  const envSyncRef = useRef<string | null>(null);
  useEffect(() => {
    if (!plan) return;
    const serverValue = plan.environmentId ?? null;
    if (envSyncRef.current !== null && envSyncRef.current !== serverValue && environmentId !== serverValue) return;
    envSyncRef.current = serverValue;
    setEnvironmentId(serverValue);
  }, [plan, environmentId]);

  const patchPlan = useMutation({
    mutationFn: (body: Parameters<typeof api.plans.patch>[1]) => api.plans.patch(id!, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plan', id] });
      qc.invalidateQueries({ queryKey: ['plans', projectId] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const setCases = useMutation({
    mutationFn: (caseIds: string[]) => api.plans.setCases(id!, caseIds),
    onSuccess: () => {
      toast(t('plans:casesUpdated'), 'success');
      qc.invalidateQueries({ queryKey: ['plan', id] });
      qc.invalidateQueries({ queryKey: ['plans', projectId] });
      setShowAdd(false);
      setSelectedAdd(new Set());
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const reorder = useMutation({
    mutationFn: (caseIds: string[]) => api.plans.reorderCases(id!, caseIds),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plan', id] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const removeCases = useMutation({
    mutationFn: (caseIds: string[]) => api.plans.removeCases(id!, caseIds),
    onSuccess: (data, vars) => {
      toast(t('plans:removedCount', { count: vars.length }), 'success');
      setConfirmRemoveCase(null);
      qc.invalidateQueries({ queryKey: ['plan', id] });
      qc.invalidateQueries({ queryKey: ['plans', projectId] });
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

  const moveBy = (idx: number, delta: number) => {
    const list = [...(plan.cases ?? [])];
    const j = idx + delta;
    if (j < 0 || j >= list.length) return;
    [list[idx], list[j]] = [list[j]!, list[idx]!];
    reorder.mutate(list.map((c) => c.id));
  };

  const onDragStart = (e: React.DragEvent, idx: number) => {
    e.dataTransfer.setData('text/plain', String(idx));
  };
  const onDrop = (e: React.DragEvent, idx: number) => {
    const from = Number(e.dataTransfer.getData('text/plain'));
    if (Number.isNaN(from) || from === idx) return;
    const list = [...(plan.cases ?? [])];
    const [moved] = list.splice(from, 1);
    list.splice(idx, 0, moved!);
    reorder.mutate(list.map((c) => c.id));
  };

  const updateStrategy = (v: Strategy) => patchPlan.mutate({ strategy: v });
  const updateLoginPrepare = (next: { enabled?: boolean; caseId?: string | null; detectionUrl?: string | null; successSelector?: string | null; unauthorizedKeywords?: string[] | null }) => {
    patchPlan.mutate({
      loginPrepare: {
        enabled: next.enabled ?? plan.loginPrepareEnabled,
        caseId: next.caseId === undefined ? plan.loginCaseId : next.caseId,
        detectionUrl: next.detectionUrl === undefined ? plan.detectionUrl : next.detectionUrl,
        successSelector: next.successSelector === undefined ? plan.loginSuccessSelector : next.successSelector,
        unauthorizedKeywords: next.unauthorizedKeywords === undefined ? (plan.loginUnauthorizedKeywords as string[] | null) : next.unauthorizedKeywords,
      },
    });
  };

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

      {/* 内容列限宽居中（同 PageShell clamp 容器），宽屏下表单不散成一整行 */}
      <div className="flex-1 min-h-0 overflow-y-auto p-6 flex flex-col gap-4 mx-auto w-full max-w-[min(100%-2rem,100rem)]">
        <div className="bg-card border rounded-[var(--radius-md)] p-5">
          {/* input-base 默认 width:100%，flex 行内会把标签挤到竖排；控件 flex-1 弹性填充 + 标签 shrink-0 */}
          <div className="flex items-center gap-4">
            <span className="text-[12px] shrink-0" style={{ color: 'var(--muted-foreground)' }}>{t('plans:strategy')}</span>
            <select
              value={plan.strategy}
              onChange={(e) => updateStrategy(e.target.value as Strategy)}
              className="input-base input-sm flex-1"
              style={{ minWidth: 160 }}
            >
              <option value="run_all">{t('plans:strategyRunAll')}</option>
              <option value="fail_fast">{t('plans:strategyFailFast')}</option>
            </select>
            <span className="text-[12px] shrink-0" style={{ color: 'var(--muted-foreground)' }}>{t('plans:targetEnvironment')}</span>
            <select
              value={environmentId ?? ''}
              onChange={(e) => setEnvironmentId(e.target.value || null)}
              className="input-base input-sm flex-1"
              style={{ minWidth: 160 }}
              disabled={(environments ?? []).length === 0}
            >
              <option value="">{t('plans:noEnvironmentSpecified')}</option>
              {(environments ?? []).map((env) => (
                <option key={env.id} value={env.id}>
                  {env.name}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="ghost"
              disabled={patchPlan.isPending}
              onClick={() => patchPlan.mutate({ environmentId })}
            >
              {t('common:save')}
            </Button>
          </div>
          <div className="mt-4">
            <label className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
              <input
                type="checkbox"
                checked={plan.loginPrepareEnabled}
                onChange={(e) => updateLoginPrepare({ enabled: e.target.checked })}
              />
              {t('plans:enableLoginPrepare')}
            </label>
            {plan.loginPrepareEnabled && (
              <div className="mt-3 flex flex-col gap-2 pl-5">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] shrink-0" style={{ color: 'var(--muted-foreground)' }}>{t('plans:loginCase')}</span>
                  <select
                    value={plan.loginCaseId ?? ''}
                    onChange={(e) => updateLoginPrepare({ caseId: e.target.value || null })}
                    className="input-base input-sm flex-1"
                    style={{ minWidth: 220 }}
                  >
                    <option value="">{t('plans:pleaseSelect')}</option>
                    {(loginCases ?? []).map((c) => (
                      <option key={c.id} value={c.id}>{c.title}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    placeholder={t('plans:searchCaseOrGroup')}
                    value={loginQ}
                    onChange={(e) => setLoginQ(e.target.value)}
                    className="input-base input-sm flex-1"
                    style={{ minWidth: 180 }}
                  />
                </div>
                <details className="text-[12px]">
                  <summary className="cursor-pointer" style={{ color: 'var(--muted-foreground)' }}>{t('plans:advancedConfig')}</summary>
                  <div className="mt-2 flex flex-col gap-2 pl-4 max-w-[520px]">
                    <label className="flex flex-col gap-1">
                      <span style={{ color: 'var(--muted-foreground)' }}>{t('plans:detectionUrl')}</span>
                      <input
                        type="text"
                        placeholder={t('plans:detectionUrlPlaceholder')}
                        defaultValue={plan.detectionUrl ?? ''}
                        onBlur={(e) => updateLoginPrepare({ detectionUrl: e.target.value || null })}
                        className="input-base input-sm"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span style={{ color: 'var(--muted-foreground)' }}>{t('plans:successSelector')}</span>
                      <input
                        type="text"
                        placeholder={t('plans:successSelectorPlaceholder')}
                        defaultValue={plan.loginSuccessSelector ?? ''}
                        onBlur={(e) => updateLoginPrepare({ successSelector: e.target.value || null })}
                        className="input-base input-sm"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span style={{ color: 'var(--muted-foreground)' }}>{t('plans:unauthorizedKeywords')}</span>
                      <textarea
                        defaultValue={((plan.loginUnauthorizedKeywords as string[] | null) ?? []).join('\n')}
                        onBlur={(e) => {
                          const lines = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean);
                          updateLoginPrepare({ unauthorizedKeywords: lines.length ? lines : null });
                        }}
                        className="input-base input-sm"
                        rows={3}
                      />
                    </label>
                  </div>
                </details>
              </div>
            )}
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
          {plan.cases.length === 0 ? (
            <EmptyState icon="flag" title={t('plans:noCases')} description={t('plans:noCasesHint')} />
          ) : (
            <ol className="flex flex-col gap-2" data-stagger>
              {plan.cases.map((c, idx) => {
                  const crossVersion = plan.versionId && c.versionId && c.versionId !== plan.versionId;
                  return (
                    <li
                      key={c.id}
                      data-stagger-item
                      draggable
                      onDragStart={(e) => onDragStart(e, idx)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => onDrop(e, idx)}
                      className="flex items-center gap-3 px-3 py-2 rounded-[var(--radius-sm)] list-row-clickable"
                      style={{ background: 'var(--muted)', border: '1px solid var(--border)' }}
                    >
                      <Icon name="gripVertical" size={12} className="cursor-grab shrink-0" style={{ color: 'var(--muted-foreground)' }} />
                      <span className="text-[11px] font-mono shrink-0 w-5" style={{ color: 'var(--muted-foreground)' }}>{idx + 1}</span>
                      <span
                        onClick={() => navigate(c.versionId ? `/p/${projectId}/v/${c.versionId}/cases/${c.id}` : `/`)}
                        className="text-[12px] flex-1 truncate cursor-pointer"
                        style={{ color: 'var(--foreground)' }}
                      >
                        {c.title}
                      </span>
                      {crossVersion ? (
                        <span
                          className="text-[10px] font-semibold uppercase px-1.5 py-[1px] rounded"
                          style={{ background: 'var(--warning-soft, var(--primary-soft))', color: 'var(--warning, var(--primary))', letterSpacing: '0.04em' }}
                          title={t('plans:crossVersionTitle')}
                        >
                          {t('plans:crossVersion')}
                        </span>
                      ) : null}
                      <IconButton icon="chevronUp" title={t('cases:moveUp')} onClick={() => moveBy(idx, -1)} />
                      <IconButton icon="chevronDown" title={t('cases:moveDown')} onClick={() => moveBy(idx, 1)} />
                      <IconButton
                        icon="trash"
                        title={t('plans:removeFromPlan')}
                        tone="destructive"
                        disabled={removeCases.isPending}
                        onClick={() => setConfirmRemoveCase({ id: c.id, title: c.title })}
                      />
                      <StatusPill status="default">{c.id.slice(0, 8)}</StatusPill>
                    </li>
                  );
                })}
              </ol>
          )}
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
          <div className="px-5 pb-4 max-h-[400px] overflow-y-auto flex flex-col gap-1">
            {candidates.length === 0 ? (
              <div className="text-[12px] py-8 text-center" style={{ color: 'var(--muted-foreground)' }}>
                {hasAddFilter || search.trim() ? t('plans:noMatchingCases') : t('plans:noAddableCases')}
              </div>
            ) : (
              candidates.map((c) => {
                const checked = selectedAdd.has(c.id);
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
                const next = [...plan.cases.map((c) => c.id), ...Array.from(selectedAdd)];
                setCases.mutate(next);
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

      {/* 用例移除确认:误删需重新打开"添加用例"找回,前端一律先弹再发请求 */}
      <Dialog open={!!confirmRemoveCase} onOpenChange={(o) => !o && setConfirmRemoveCase(null)}>
        <DialogContent style={{ maxWidth: 420 }}>
          <DialogHeader><DialogTitle>{t('plans:removeCaseTitle')}</DialogTitle></DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
            {t('plans:removeCaseConfirm', { title: confirmRemoveCase?.title })}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmRemoveCase(null)}>{t('common:cancel')}</Button>
            <Button
              variant="danger"
              disabled={removeCases.isPending}
              onClick={() => confirmRemoveCase && removeCases.mutate([confirmRemoveCase.id])}
            >
              {removeCases.isPending ? t('plans:removing') : t('plans:confirmRemove')}
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
