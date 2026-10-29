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
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '../ui/shadcn/dropdown-menu';

/** 登录准备候选（/plans/:id/login-cases，页面级查询下发）。 */
export type LoginCaseOption = { id: string; title: string; groupId: string };

/** 计划分组卡：组名/顺序/环境/登录准备/failFast/浏览器上下文的组级配置 + 组内用例编排。
 *  所有写操作成功后由 onInvalidate 统一失效 ['plan', id]（含列表计数）。 */
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
  /** 打开添加用例弹窗并锁定目标为本组（弹窗内不再选组）。 */
  onAddCases: () => void;
}) {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const navigate = useNavigate();
  const { projectId } = plan;

  const [loginQ, setLoginQ] = useState('');
  /** 组内行移除确认（与旧计划级列表同款防误点弹窗）。 */
  const [confirmRemoveCase, setConfirmRemoveCase] = useState<{ id: string; title: string } | null>(null);

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
      // 组内还有用例 → 后端 409 group_not_empty，给可操作指引而非原始报错
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

  const updateLoginPrepare = (next: { enabled?: boolean; caseId?: string | null; detectionUrl?: string | null; successSelector?: string | null; unauthorizedKeywords?: string[] | null }) => {
    patchGroup.mutate({
      loginPrepare: {
        enabled: next.enabled ?? group.loginPrepareEnabled,
        caseId: next.caseId === undefined ? group.loginCaseId : next.caseId,
        detectionUrl: next.detectionUrl === undefined ? group.detectionUrl : next.detectionUrl,
        successSelector: next.successSelector === undefined ? group.loginSuccessSelector : next.successSelector,
        unauthorizedKeywords: next.unauthorizedKeywords === undefined ? (group.loginUnauthorizedKeywords as string[] | null) : next.unauthorizedKeywords,
      },
    });
  };

  const browserContext = group.targetConfig?.browserContext ?? '';

  return (
    <div className="bg-card border rounded-[var(--radius-md)] p-5">
      {/* 组头：名称行内编辑 + 组间排序 + 组级配置（环境/登录准备/failFast/浏览器上下文） */}
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

      {/* 组级登录准备：环境凭据自动登录 / 登录用例前置（从计划级面板平移） */}
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
              <select
                value={group.loginCaseId ?? ''}
                onChange={(e) => updateLoginPrepare({ caseId: e.target.value || null })}
                className="input-base input-sm flex-1"
                style={{ minWidth: 220 }}
              >
                <option value="">{t('plans:pleaseSelect')}</option>
                {loginCases
                  .filter((c) => !loginQ.trim() || c.title.toLowerCase().includes(loginQ.trim().toLowerCase()))
                  .map((c) => (
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

      {/* 组内用例：拖拽/上下移组内重排，行尾可跨组移动（跨组重复合法，按 planCaseId 移动） */}
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

      {/* 组内行移除确认：removeCases 按 caseId 删该计划所有行（跨组重复行一并删） */}
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
