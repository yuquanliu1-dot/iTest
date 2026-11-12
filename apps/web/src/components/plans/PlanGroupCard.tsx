import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, type Environment, type PlanCaseGroup, type PlanDetail } from '../../api/client';
import { localizeApiError } from '../../i18n';
import { useUIStore } from '../../stores/ui';
import Icon from '../Icon';
import StatusPill from '../ui/StatusPill';
import EmptyState from '../ui/EmptyState';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import InlineEdit from '../ui/InlineEdit';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/Modal';
import DatasetRowPickerDialog from '../DatasetRowPickerDialog';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '../ui/shadcn/dropdown-menu';
import LoginCasePickerDialog from './LoginCasePickerDialog';

/** Login prepare candidates (/plans/:id/login-cases, delivered by the page-level query). */
export type LoginCaseOption = { id: string; title: string; groupId: string };

/** Plan group card: group-level config for name/order/environment/login prepare/failFast/browser context + in-group case ordering.
 *  After every write succeeds, onInvalidate invalidates ['plan', id] in one place (list counts included). */
export default function PlanGroupCard({
  plan,
  group,
  groups,
  environments,
  loginCases,
  onInvalidate,
  onAddCases,
}: {
  plan: PlanDetail;
  group: PlanCaseGroup;
  groups: PlanCaseGroup[];
  environments: Environment[];
  loginCases: LoginCaseOption[];
  onInvalidate: () => void;
  /** Open the add-cases dialog locked to this group (no group picking inside the dialog). */
  onAddCases: () => void;
}) {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const navigate = useNavigate();
  const { projectId } = plan;

  /** In-group row removal confirm (same anti-misclick dialog as the old plan-level list). */
  const [confirmRemoveCase, setConfirmRemoveCase] = useState<{ id: string; title: string } | null>(null);
  /** Target row of the inline "pick data" dialog (null = closed). Stores the whole row: projectId/datasetId/effective indexes all come from it. */
  const [datasetPickerCase, setDatasetPickerCase] = useState<PlanCaseGroup['cases'][number] | null>(null);
  /** Login case picker dialog / login case dataset row dialog. */
  const [loginPickerOpen, setLoginPickerOpen] = useState(false);
  const [loginRowPickerOpen, setLoginRowPickerOpen] = useState(false);

  const invalidate = () => onInvalidate();

  const patchGroup = useMutation({
    mutationFn: (body: Parameters<typeof api.plans.patchGroup>[2]) => api.plans.patchGroup(plan.id, group.id, body),
    onSuccess: invalidate,
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const deleteGroup = useMutation({
    mutationFn: () => api.plans.deleteGroup(plan.id, group.id),
    onSuccess: () => {
      toast(t('plans:deletedToast'), 'success');
      invalidate();
    },
    onError: (e: Error) => {
      // Group still has cases → backend 409 group_not_empty; give an actionable hint instead of the raw error
      if (e instanceof ApiError && (e.status === 409 || e.code === 'group_not_empty')) {
        toast(t('plans:groupNotEmpty'), 'error');
        return;
      }
      toast(localizeApiError(e), 'error');
    },
  });

  const reorderGroups = useMutation({
    mutationFn: (groupIds: string[]) => api.plans.reorderGroups(plan.id, groupIds),
    onSuccess: invalidate,
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const reorderGroupCases = useMutation({
    mutationFn: (caseIds: string[]) => api.plans.reorderGroupCases(plan.id, group.id, caseIds),
    onSuccess: invalidate,
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const moveCases = useMutation({
    mutationFn: ({ planCaseIds, toGroupId }: { planCaseIds: string[]; toGroupId: string }) =>
      api.plans.moveCases(plan.id, planCaseIds, toGroupId),
    onSuccess: invalidate,
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const patchPlanCase = useMutation({
    mutationFn: ({ planCaseId, datasetRowIndexes }: { planCaseId: string; datasetRowIndexes: number[] | null }) =>
      api.plans.patchPlanCase(plan.id, planCaseId, { datasetRowIndexes }),
    onSuccess: invalidate,
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  /** Inline dataset-selection status label, three states: follow case · N rows (N = case-level effective count) / all N rows / M selected. */
  const datasetStatusLabel = (c: PlanCaseGroup['cases'][number]): string => {
    if (c.planRowIndexes !== null) {
      return c.planRowIndexes.length === 0
        ? t('plans:datasetAllRows', { count: c.datasetEnabledRowCount })
        : t('plans:datasetSelectedRows', { count: c.planRowIndexes.length });
    }
    const n = c.caseRowIndexes.length === 0 ? c.datasetEnabledRowCount : c.caseRowIndexes.length;
    return t('plans:datasetFollowCaseRows', { count: n });
  };

  const removeCases = useMutation({
    mutationFn: (caseIds: string[]) => api.plans.removeCases(plan.id, caseIds),
    onSuccess: (data, vars) => {
      toast(t('plans:removedCount', { count: vars.length }), 'success');
      setConfirmRemoveCase(null);
      invalidate();
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const groupIdx = groups.findIndex((g) => g.id === group.id);
  const otherGroups = groups.filter((g) => g.id !== group.id);

  const moveGroupBy = (delta: number) => {
    const ids = groups.map((g) => g.id);
    const j = groupIdx + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[groupIdx], ids[j]] = [ids[j]!, ids[groupIdx]!];
    reorderGroups.mutate(ids);
  };

  const moveBy = (idx: number, delta: number) => {
    const list = [...group.cases];
    const j = idx + delta;
    if (j < 0 || j >= list.length) return;
    [list[idx], list[j]] = [list[j]!, list[idx]!];
    reorderGroupCases.mutate(list.map((c) => c.id));
  };

  const onDragStart = (e: React.DragEvent, idx: number) => {
    e.dataTransfer.setData('text/plain', String(idx));
  };
  const onDrop = (e: React.DragEvent, idx: number) => {
    const from = Number(e.dataTransfer.getData('text/plain'));
    if (Number.isNaN(from) || from === idx) return;
    const list = [...group.cases];
    const [moved] = list.splice(from, 1);
    list.splice(idx, 0, moved!);
    reorderGroupCases.mutate(list.map((c) => c.id));
  };

  const updateLoginPrepare = (next: { enabled?: boolean; caseId?: string | null; detectionUrl?: string | null; successSelector?: string | null; unauthorizedKeywords?: string[] | null; datasetRowIndexes?: number[] | null }) => {
    const caseChanged = next.caseId !== undefined && next.caseId !== group.loginCaseId;
    patchGroup.mutate({
      loginPrepare: {
        enabled: next.enabled ?? group.loginPrepareEnabled,
        caseId: next.caseId === undefined ? group.loginCaseId : next.caseId,
        detectionUrl: next.detectionUrl === undefined ? group.detectionUrl : next.detectionUrl,
        successSelector: next.successSelector === undefined ? group.loginSuccessSelector : next.successSelector,
        unauthorizedKeywords: next.unauthorizedKeywords === undefined ? (group.loginUnauthorizedKeywords as string[] | null) : next.unauthorizedKeywords,
        // Case changed → clear the row override too (the index space belongs to the old case's dataset); when unchanged, pass explicitly or keep the current value
        datasetRowIndexes: caseChanged ? null : next.datasetRowIndexes === undefined ? group.loginDatasetRowIndexes : next.datasetRowIndexes,
      },
    });
  };

  /** Login case dataset-row label, three states: follow case · N rows / all N rows / M selected (same as in-group cases). */
  const loginDatasetStatusLabel = (): string => {
    if (group.loginDatasetRowIndexes !== null) {
      return group.loginDatasetRowIndexes.length === 0
        ? t('plans:datasetAllRows', { count: group.loginCaseEnabledRowCount })
        : t('plans:datasetSelectedRows', { count: group.loginDatasetRowIndexes.length });
    }
    const n = group.loginCaseRowIndexes.length === 0 ? group.loginCaseEnabledRowCount : group.loginCaseRowIndexes.length;
    return t('plans:datasetFollowCaseRows', { count: n });
  };

  const browserContext = group.targetConfig?.browserContext ?? '';

  return (
    <div className="bg-card border rounded-[var(--radius-md)] p-5">
      {/* Group header: inline name editing + group reordering + group-level config (environment / login prepare / failFast / browser context) */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-[11px] font-mono shrink-0" style={{ color: 'var(--muted-foreground)' }}>
          {t('plans:groupOrder', { index: groupIdx + 1 })}
        </span>
        <InlineEdit
          value={group.name}
          disabled={patchGroup.isPending}
          ariaLabel={t('plans:groupNameAria')}
          onSave={(next) => patchGroup.mutateAsync({ name: next })}
          className="text-[13px] font-semibold max-w-[240px]"
          inputClassName="text-[13px] font-semibold max-w-[240px]"
          style={{ color: 'var(--foreground)' }}
        />
        <IconButton icon="chevronUp" title={t('cases:moveUp')} onClick={() => moveGroupBy(-1)} disabled={groupIdx <= 0} />
        <IconButton icon="chevronDown" title={t('cases:moveDown')} onClick={() => moveGroupBy(1)} disabled={groupIdx >= groups.length - 1} />
        <div className="flex-1" />
        <label className="flex items-center gap-2 text-[12px] shrink-0" style={{ color: 'var(--muted-foreground)' }}>
          {t('plans:targetEnvironment')}
          <select
            value={group.environmentId ?? ''}
            onChange={(e) => patchGroup.mutate({ environmentId: e.target.value || null })}
            className="input-base input-sm"
            style={{ width: 180 }}
            disabled={environments.length === 0}
          >
            <option value="">{t('plans:noEnvironmentSpecified')}</option>
            {environments.map((env) => (
              <option key={env.id} value={env.id}>{env.name}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[12px] shrink-0" style={{ color: 'var(--muted-foreground)' }}>
          {t('plans:groupBrowserContext')}
          <select
            value={browserContext}
            onChange={(e) => {
              const v = e.target.value;
              patchGroup.mutate({ targetConfig: { ...group.targetConfig, browserContext: v ? (v as 'incognito' | 'persistent') : undefined } });
            }}
            className="input-base input-sm"
            style={{ width: 130 }}
          >
            <option value="">{t('plans:followCase')}</option>
            <option value="incognito">{t('plans:incognito')}</option>
            <option value="persistent">{t('plans:persistent')}</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-[12px] shrink-0" style={{ color: 'var(--muted-foreground)' }}>
          <input
            type="checkbox"
            checked={group.failFast}
            disabled={patchGroup.isPending}
            onChange={(e) => patchGroup.mutate({ failFast: e.target.checked })}
          />
          {t('plans:groupFailFast')}
        </label>
        <IconButton
          icon="trash"
          title={t('plans:deleteGroupTitle')}
          tone="destructive"
          disabled={deleteGroup.isPending}
          onClick={() => deleteGroup.mutate()}
        />
      </div>

      {/* Group-level login prepare: environment-credential auto login / login case pre-step (moved over from the plan-level panel) */}
      <div className="mt-3">
        <label className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
          <input
            type="checkbox"
            checked={group.loginPrepareEnabled}
            disabled={patchGroup.isPending}
            onChange={(e) => updateLoginPrepare({ enabled: e.target.checked })}
          />
          {t('plans:enableLoginPrepare')}
        </label>
        {group.loginPrepareEnabled && (
          <div className="mt-3 flex flex-col gap-2 pl-5">
            <div className="flex items-center gap-2">
              <span className="text-[12px] shrink-0" style={{ color: 'var(--muted-foreground)' }}>{t('plans:loginCase')}</span>
              <button
                type="button"
                className="input-base input-sm flex-1 text-left"
                style={{ minWidth: 220, cursor: 'pointer' }}
                onClick={() => setLoginPickerOpen(true)}
              >
                {group.loginCaseTitle ?? t('plans:pleaseSelect')}
              </button>
              {group.loginCaseId && group.loginCaseDatasetId && (
                <button
                  type="button"
                  className="press shrink-0 text-[10px] font-medium px-1.5 py-[1px] rounded"
                  style={{ background: 'var(--muted)', color: 'var(--muted-foreground)', border: '1px solid var(--border)', cursor: 'pointer' }}
                  onClick={() => setLoginRowPickerOpen(true)}
                  title={t('plans:datasetEntry')}
                >
                  {loginDatasetStatusLabel()}
                </button>
              )}
            </div>
            <details className="text-[12px]">
              <summary className="cursor-pointer" style={{ color: 'var(--muted-foreground)' }}>{t('plans:advancedConfig')}</summary>
              <div className="mt-2 flex flex-col gap-2 pl-4 max-w-[520px]">
                <label className="flex flex-col gap-1">
                  <span style={{ color: 'var(--muted-foreground)' }}>{t('plans:detectionUrl')}</span>
                  <input
                    type="text"
                    placeholder={t('plans:detectionUrlPlaceholder')}
                    defaultValue={group.detectionUrl ?? ''}
                    onBlur={(e) => updateLoginPrepare({ detectionUrl: e.target.value || null })}
                    className="input-base input-sm"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span style={{ color: 'var(--muted-foreground)' }}>{t('plans:successSelector')}</span>
                  <input
                    type="text"
                    placeholder={t('plans:successSelectorPlaceholder')}
                    defaultValue={group.loginSuccessSelector ?? ''}
                    onBlur={(e) => updateLoginPrepare({ successSelector: e.target.value || null })}
                    className="input-base input-sm"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span style={{ color: 'var(--muted-foreground)' }}>{t('plans:unauthorizedKeywords')}</span>
                  <textarea
                    defaultValue={((group.loginUnauthorizedKeywords as string[] | null) ?? []).join('\n')}
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

      {/* In-group cases: drag / move up-down to reorder within the group; row tail can move across groups (cross-group duplicates are legal, moved by planCaseId) */}
      <div className="mt-4">
        <div className="flex items-center justify-between gap-2 mb-3 hairline-bottom pb-2">
          <div className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--muted-foreground)' }}>
            {t('plans:caseOrder', { count: group.cases.length })}
          </div>
          <Button size="sm" variant="ghost" onClick={onAddCases}>
            <Icon name="plus" size={12} />
            {t('plans:addCases')}
          </Button>
        </div>
        {group.cases.length === 0 ? (
          <EmptyState
            compact
            icon="flag"
            title={t('plans:noCases')}
            description={t('plans:noCasesHint')}
            action={
              <Button size="sm" variant="ghost" disabled={deleteGroup.isPending} onClick={() => deleteGroup.mutate()}>
                {t('plans:deleteGroupTitle')}
              </Button>
            }
          />
        ) : (
          <ol className="flex flex-col gap-2" data-stagger>
            {group.cases.map((c, idx) => {
              const fromOtherProject = c.projectId && c.projectId !== projectId;
              const fromOtherVersion = c.versionId && c.versionId !== plan.versionId;
              return (
                <li
                  key={c.planCaseId}
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
                  {fromOtherProject && c.projectName && (
                    <span
                      className="text-[10px] font-semibold px-1.5 py-[1px] rounded shrink-0"
                      style={{ background: 'var(--primary-soft, var(--muted))', color: 'var(--primary, var(--foreground))' }}
                      title={t('plans:caseFromProject', { project: c.projectName })}
                    >
                      {c.projectName}
                    </span>
                  )}
                  {fromOtherVersion && c.versionName && (
                    <span
                      className="text-[10px] font-semibold px-1.5 py-[1px] rounded shrink-0"
                      style={{ background: 'var(--warning-soft, var(--primary-soft))', color: 'var(--warning, var(--primary))' }}
                      title={t('plans:caseFromVersion', { version: c.versionName })}
                    >
                      {c.versionName}
                    </span>
                  )}
                  {/* Plan-level dataset row selection entry: shown only when a dataset is bound; opens the multi-select dialog, inline label has three states. */}
                  {c.datasetId && (
                    <button
                      type="button"
                      className="press shrink-0 text-[10px] font-medium px-1.5 py-[1px] rounded"
                      style={{ background: 'var(--muted)', color: 'var(--muted-foreground)', border: '1px solid var(--border)', cursor: 'pointer' }}
                      onClick={() => setDatasetPickerCase(c)}
                      title={t('plans:datasetEntry')}
                    >
                      {datasetStatusLabel(c)}
                    </button>
                  )}
                  {otherGroups.length > 0 && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <IconButton icon="folder" title={t('plans:moveToGroup')} />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {otherGroups.map((g) => (
                          <DropdownMenuItem key={g.id} onSelect={() => moveCases.mutate({ planCaseIds: [c.planCaseId], toGroupId: g.id })}>
                            {g.name}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
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

      {/* In-group row removal confirm: removeCases deletes all rows of that case in the plan by caseId (cross-group duplicates removed too) */}
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

      {/* Plan-level dataset row picker: value = effective indexes (plan override; falls back to case-level effective values when uncovered).
          Cross-line shared cases fetch the dataset from the case's own project (projectId ?? plan.projectId). */}
      {datasetPickerCase && (
        <DatasetRowPickerDialog
          open
          onOpenChange={(o) => !o && setDatasetPickerCase(null)}
          projectId={datasetPickerCase.projectId ?? plan.projectId}
          datasetId={datasetPickerCase.datasetId}
          value={datasetPickerCase.planRowIndexes ?? datasetPickerCase.caseRowIndexes}
          onConfirm={(indexes) =>
            patchPlanCase.mutate({ planCaseId: datasetPickerCase.planCaseId, datasetRowIndexes: indexes })
          }
          onFollowCase={
            datasetPickerCase.planRowIndexes !== null
              ? () => patchPlanCase.mutate({ planCaseId: datasetPickerCase.planCaseId, datasetRowIndexes: null })
              : undefined
          }
        />
      )}

      {/* Login case picker dialog: candidates come from the page-level login-cases query; clicking a row picks it. */}
      {loginPickerOpen && (
        <LoginCasePickerDialog
          open
          onOpenChange={(o) => !o && setLoginPickerOpen(false)}
          cases={loginCases}
          selectedId={group.loginCaseId}
          onPick={(caseId) => updateLoginPrepare({ caseId })}
        />
      )}

      {/* Login case dataset row picker: same three states as in-group cases (follow case = clear the group-level override).
          Login case candidates are limited to this plan's project; the dataset always belongs to plan.projectId. */}
      {loginRowPickerOpen && (
        <DatasetRowPickerDialog
          open
          onOpenChange={(o) => !o && setLoginRowPickerOpen(false)}
          projectId={plan.projectId}
          datasetId={group.loginCaseDatasetId}
          value={group.loginDatasetRowIndexes ?? group.loginCaseRowIndexes}
          onConfirm={(indexes) => updateLoginPrepare({ datasetRowIndexes: indexes })}
          onFollowCase={
            group.loginDatasetRowIndexes !== null
              ? () => updateLoginPrepare({ datasetRowIndexes: null })
              : undefined
          }
        />
      )}
    </div>
  );
}
