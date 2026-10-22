import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { localizeApiError } from '../i18n';
import { api, type ProductLine, type ProjectVersion } from '../api/client';
import { useProjectStore } from '../stores/project';
import { useUIStore } from '../stores/ui';
import { useAuthStore } from '../stores/auth';
import Icon from '../components/Icon';
import EmptyState from '../components/ui/EmptyState';
import IconButton from '../components/ui/IconButton';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/Modal';
import Input from '../components/ui/Input';
import Button from '../components/ui/Button';
import RepoFields, { EMPTY_REPO, type RepoFieldsValue } from '../components/ui/RepoFields';
import RefEditDialog, { EMPTY_REF_FORM, type RefFormState } from '../components/version/RefEditDialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/Table';
import {
  PageShell,
  PageShellContent,
  PageShellDescription,
  PageShellHeader,
  PageShellTitle,
} from '../components/layout/PageShell';

interface FormState {
  open: boolean;
  mode: 'create-project' | 'edit-project';
  id: string | null;
  name: string;
  description: string;
  repo: RepoFieldsValue;
}
interface VersionFormState {
  open: boolean;
  mode: 'create' | 'edit';
  projectId: string;
  projectName: string;
  versionId: string | null;
  name: string;
  description: string;
  /** 关联环境 id；空串 = 跟随项目默认环境 */
  environmentId: string;
}
type LineDraft = { name: string; description: string };

/** 按用户记忆的项目展开状态（localStorage）；AuthGuard 保证挂载时 user 已就绪。 */
function readExpandedProjects(userId: string | null): Set<string> {
  if (!userId) return new Set();
  try {
    const raw = localStorage.getItem(`itest-expanded-projects:${userId}`);
    const list: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(list) ? new Set(list.filter((x): x is string => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

/** 上次选中的产品线；空串/undefined = 没记忆过，首次进页面选第一条线。 */
function readSelectedLine(userId: string | null): string | null {
  if (!userId) return null;
  try {
    return localStorage.getItem(`itest-selected-line:${userId}`) || null;
  } catch {
    return null;
  }
}

const EMPTY_FORM: FormState = {
  open: false,
  mode: 'create-project',
  id: null,
  name: '',
  description: '',
  repo: EMPTY_REPO,
};
const EMPTY_VERSION_FORM: VersionFormState = {
  open: false,
  mode: 'create',
  projectId: '',
  projectName: '',
  versionId: null,
  name: '',
  description: '',
  environmentId: '',
};
const EMPTY_LINE_DRAFT: LineDraft = { name: '', description: '' };

/** 项目与产品线合并页（方案 C）：上方产品线卡片条 + 下方项目平铺表，行展开仍是版本管理。 */
export default function ProjectsHome() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const enter = useProjectStore((s) => s.enter);
  const switchVersion = useProjectStore((s) => s.switchVersion);
  const canManage = useAuthStore((s) => s.organizations.some((o) => o.isManager));
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const { data, isLoading } = useQuery({ queryKey: ['projects'], queryFn: api.projects.list });
  const { data: lines } = useQuery({ queryKey: ['productLines'], queryFn: () => api.productLines.list() });
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [versionForm, setVersionForm] = useState<VersionFormState>(EMPTY_VERSION_FORM);
  const [refForm, setRefForm] = useState<RefFormState>(EMPTY_REF_FORM);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  /** 删除版本前一律先弹 modal —— 误点会丢该版本下所有用例、计划与历史报告。 */
  const [confirmDeleteVersion, setConfirmDeleteVersion] = useState<{ projectId: string; versionId: string; versionName: string } | null>(null);
  // 产品线弹窗状态：新建/编辑草稿、删除确认、成员管理（挂载/摘除同一弹窗）
  const [lineDraft, setLineDraft] = useState<LineDraft | null>(null);
  const [lineEditingId, setLineEditingId] = useState<string | null>(null);
  const [confirmDeleteLine, setConfirmDeleteLine] = useState<ProductLine | null>(null);
  const [manageLine, setManageLine] = useState<ProductLine | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // 卡片即过滤器：默认选第一条线；记住上次选择，lineId 为 null 表示"不过滤"
  const [filterLineId, setFilterLineId] = useState<string | null>(() => readSelectedLine(userId));
  // 版本弹窗的环境下拉数据源：仅弹窗打开时拉取
  const envsQ = useQuery({
    queryKey: ['environments', versionForm.projectId],
    queryFn: () => api.environments.list(versionForm.projectId),
    enabled: versionForm.open && !!versionForm.projectId,
  });
  // 展开状态：默认全部收起，避免大量项目时首屏刷屏；展开过的项目按用户记忆
  const expandedKey = userId ? `itest-expanded-projects:${userId}` : null;
  const [expanded, setExpanded] = useState<Set<string>>(() => readExpandedProjects(userId));
  useEffect(() => {
    if (!expandedKey) return;
    try {
      localStorage.setItem(expandedKey, JSON.stringify([...expanded]));
    } catch {
      // localStorage 不可用时展开状态仅内存有效。
    }
  }, [expanded, expandedKey]);
  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectLine = (id: string | null) => {
    setFilterLineId(id);
    if (!userId) return;
    try {
      if (id) localStorage.setItem(`itest-selected-line:${userId}`, id);
      else localStorage.removeItem(`itest-selected-line:${userId}`);
    } catch {
      // localStorage 不可用时选择仅本次会话有效。
    }
  };
  // 首次进入（或记忆的线已不存在）默认选第一条线；用户主动取消过滤后不再被拉回
  const lineDefaultedRef = useRef(false);
  useEffect(() => {
    if (!lines || lines.length === 0) return;
    if (!filterLineId || !lines.some((l) => l.id === filterLineId)) {
      if (lineDefaultedRef.current) return;
      lineDefaultedRef.current = true;
      selectLine(lines[0]?.id ?? null);
    }
  }, [lines, filterLineId]);

  const save = useMutation({
    mutationFn: async () => {
      const r = form.repo;
      const baseBody = {
        name: form.name,
        description: form.description || undefined,
        repoUrl: r.repoUrl.trim() || undefined,
        defaultBranch: r.defaultBranch.trim() || undefined,
        provider: r.repoUrl.trim() ? r.provider : undefined,
        gitlabUrlOverride: r.provider === 'gitlab' && r.gitlabUrlOverride.trim() ? r.gitlabUrlOverride.trim() : undefined,
        patOverride: r.patOverride.trim() ? r.patOverride.trim() : undefined,
      };
      if (form.mode === 'create-project') return api.projects.create(baseBody);
      return api.projects.patch(form.id!, baseBody);
    },
    onSuccess: () => {
      toast(form.mode === 'create-project' ? t('projects:created') : t('projects:updated'), 'success');
      setForm(EMPTY_FORM);
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.projects.remove(id),
    onSuccess: () => {
      toast(t('projects:deleted'), 'success');
      setConfirmDelete(null);
      setExpanded((prev) => {
        if (!prev.has(confirmDelete?.id ?? '')) return prev;
        const next = new Set(prev);
        next.delete(confirmDelete!.id);
        return next;
      });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (e: Error) => {
      toast(e.message.includes('409') || e.message.includes('cases') ? t('projects:deleteBlockedByCases') : e.message, 'error');
      setConfirmDelete(null);
    },
  });

  const createVersion = useMutation({
    mutationFn: () =>
      api.versions.create(versionForm.projectId, {
        name: versionForm.name,
        description: versionForm.description || undefined,
        environmentId: versionForm.environmentId || null,
      }),
    onSuccess: (v) => {
      toast(t('projects:versionCreated', { name: v.name }), 'success');
      setVersionForm(EMPTY_VERSION_FORM);
      qc.invalidateQueries({ queryKey: ['versions', versionForm.projectId] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const editVersion = useMutation({
    mutationFn: () =>
      api.versions.patch(versionForm.versionId!, {
        name: versionForm.name.trim(),
        description: versionForm.description.trim() ? versionForm.description.trim() : null,
        environmentId: versionForm.environmentId || null,
      }),
    onSuccess: (v) => {
      toast(t('projects:versionUpdated', { name: v.name }), 'success');
      setVersionForm(EMPTY_VERSION_FORM);
      qc.invalidateQueries({ queryKey: ['versions', versionForm.projectId] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const removeVersion = useMutation({
    mutationFn: ({ projectId, versionId }: { projectId: string; versionId: string }) =>
      api.versions.remove(projectId, versionId),
    onSuccess: () => {
      toast(t('projects:versionDeleted'), 'success');
      setConfirmDeleteVersion(null);
      qc.invalidateQueries({ queryKey: ['versions'] });
    },
    onError: (e: Error) => {
      toast(localizeApiError(e), 'error');
      setConfirmDeleteVersion(null);
    },
  });

  const saveRef = useMutation({
    mutationFn: ({ versionId, ref, refKind }: { versionId: string; ref: string | null; refKind: 'branch' | 'tag' | null }) =>
      api.versions.setRef(versionId, { ref, refKind }),
    onSuccess: () => {
      toast(t('projects:saved'), 'success');
      setRefForm(EMPTY_REF_FORM);
      qc.invalidateQueries({ queryKey: ['versions'] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const saveLine = useMutation({
    mutationFn: (d: LineDraft) => {
      const body = { name: d.name.trim(), description: d.description.trim() || undefined };
      return lineEditingId
        ? api.productLines.patch(lineEditingId, body)
        : api.productLines.create(body);
    },
    onSuccess: () => {
      toast(t('productLines:saved'), 'success');
      setLineDraft(null);
      setLineEditingId(null);
      qc.invalidateQueries({ queryKey: ['productLines'] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const removeLine = useMutation({
    mutationFn: (line: ProductLine) => api.productLines.remove(line.id),
    onSuccess: (_r, line) => {
      toast(t('productLines:deleted'), 'success');
      setConfirmDeleteLine(null);
      // 被删的线若正被选中，落到剩下的第一条线，别把用户留在空视图
      if (filterLineId === line.id) {
        const rest = (lines ?? []).filter((l) => l.id !== line.id);
        selectLine(rest[0]?.id ?? null);
      }
      // 项目归属变了：项目表里的归属徽标需要重取
      qc.invalidateQueries({ queryKey: ['productLines'] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const attach = useMutation({
    mutationFn: ({ lineId, ids }: { lineId: string; ids: string[] }) =>
      api.productLines.attachProjects(lineId, ids),
    onSuccess: (_r, v) => {
      toast(t('productLines:attached', { count: v.ids.length }), 'success');
      setPicked(new Set());
      qc.invalidateQueries({ queryKey: ['productLines'] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const detach = useMutation({
    mutationFn: ({ lineId, projectId }: { lineId: string; projectId: string }) =>
      api.productLines.detachProject(lineId, projectId),
    onSuccess: () => {
      toast(t('productLines:detached'), 'success');
      qc.invalidateQueries({ queryKey: ['productLines'] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  /** 某条线内的项目（从 allProjects 的 productLineId 反查，避免为每条线发一次详情请求）。 */
  const projectsOf = (lineId: string) => (data ?? []).filter((p) => p.productLineId === lineId);
  /** 可挂载候选：仅未归线的项目——一个项目至多属于一条产品线，已归线的挂进来等于静默改归属。 */
  const attachable = (data ?? []).filter((p) => !p.productLineId);
  const manageLineMembers = manageLine ? projectsOf(manageLine.id) : [];

  const enterVersion = (projectId: string, projectName: string, v: ProjectVersion) => {
    enter({ id: projectId, name: projectName, versionId: v.id, versionName: v.name });
    switchVersion(v.id, v.name);
    navigate(`/p/${projectId}/v/${v.id}/assistant`);
  };

  const allProjects = data ?? [];
  const filtered = filterLineId ? allProjects.filter((p) => p.productLineId === filterLineId) : allProjects;

  return (
    <PageShell>
      <PageShellHeader>
        <PageShellTitle>{t('projects:titleMerged')}</PageShellTitle>
        <PageShellDescription>{t('projects:subtitleMerged')}</PageShellDescription>
      </PageShellHeader>

      <PageShellContent>
        {isLoading ? (
          <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--muted-foreground)', fontSize: 13 }}>
            <Icon name="loader" size={16} className="animate-spin" />
            <span style={{ marginLeft: 8 }}>{t('common:loading')}</span>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* 产品线卡片条：既是归属一览，也当过滤器——选中后下方只列该线项目；再点一次取消 */}
            {((lines?.length ?? 0) > 0 || canManage) && (
              <div className="flex gap-3 overflow-x-auto pb-1" data-stagger>
                {(lines ?? []).map((line) => {
                  const ps = projectsOf(line.id);
                  const active = filterLineId === line.id;
                  return (
                    <div
                      key={line.id}
                      data-stagger-item
                      role="button"
                      tabIndex={0}
                      aria-pressed={active}
                      onClick={() => selectLine(active ? null : line.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          selectLine(active ? null : line.id);
                        }
                      }}
                      className="flex-none w-[236px] border rounded-[var(--radius-md)] p-3 cursor-pointer"
                      style={{
                        borderColor: active ? 'var(--primary)' : 'var(--border)',
                        background: active ? 'var(--primary-soft)' : 'var(--card)',
                      }}
                    >
                      <div className="flex items-center gap-1.5">
                        <Icon name="gitBranch" size={14} className="shrink-0" style={{ color: 'var(--primary)' }} />
                        <span className="text-[13px] font-semibold truncate min-w-0" style={{ color: 'var(--foreground)' }}>
                          {line.name}
                        </span>
                        <span className="ml-auto text-[11px] tabular-nums shrink-0" style={{ color: 'var(--muted-foreground)' }}>
                          {ps.length}
                        </span>
                        {canManage && (
                          <div className="flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                            <IconButton
                              icon="pencil"
                              title={t('productLines:edit')}
                              onClick={() => {
                                setLineEditingId(line.id);
                                setLineDraft({ name: line.name, description: line.description ?? '' });
                              }}
                            />
                            <IconButton
                              icon="trash"
                              title={t('common:delete')}
                              tone="destructive"
                              onClick={() => setConfirmDeleteLine(line)}
                            />
                          </div>
                        )}
                      </div>
                      {line.description && (
                        <div className="text-[11px] mt-1 truncate" title={line.description} style={{ color: 'var(--muted-foreground)' }}>
                          {line.description}
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setManageLine(line);
                          setPicked(new Set());
                        }}
                        title={ps.length ? ps.map((p) => p.name).join(' · ') : t('productLines:noProjects')}
                        className="text-[11px] mt-2 max-w-full truncate text-left hover:underline"
                        style={{ color: 'var(--muted-foreground)', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
                      >
                        {ps.length === 0 ? t('productLines:noProjects') : ps.map((p) => p.name).join(' · ')}
                      </button>
                    </div>
                  );
                })}
                {canManage && (
                  <button
                    type="button"
                    data-stagger-item
                    onClick={() => {
                      setLineEditingId(null);
                      setLineDraft({ ...EMPTY_LINE_DRAFT });
                    }}
                    className="flex-none w-[236px] min-h-[64px] border border-dashed rounded-[var(--radius-md)] flex items-center justify-center text-[12px]"
                    style={{ color: 'var(--muted-foreground)', borderColor: 'var(--border)', cursor: 'pointer', background: 'transparent' }}
                  >
                    {t('productLines:newBtn')}
                  </button>
                )}
              </div>
            )}

            {allProjects.length === 0 ? (
              <EmptyState
                icon="layers"
                title={t('projects:emptyTitle')}
                description={t('projects:emptyDescription')}
              />
            ) : filtered.length === 0 ? (
              <EmptyState
                icon="gitBranch"
                compact
                title={t('productLines:noProjects')}
                action={
                  <Button size="sm" variant="ghost" onClick={() => selectLine(null)}>
                    {t('productLines:clearFilter')}
                  </Button>
                }
              />
            ) : (
              <>
                <div className="flex justify-end">
                  <Button
                    onClick={() =>
                      setForm({
                        open: true,
                        mode: 'create-project',
                        id: null,
                        name: '',
                        description: '',
                        repo: EMPTY_REPO,
                      })
                    }
                  >
                    <Icon name="plus" size={14} />
                    {t('projects:createProject')}
                  </Button>
                </div>
                <div className="border rounded-[var(--radius-md)] overflow-hidden" style={{ borderColor: 'var(--border)' }}>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-3">{t('projects:colProject')}</TableHead>
                      <TableHead>{t('projects:colProductLine')}</TableHead>
                      <TableHead>{t('projects:colCases')}</TableHead>
                      <TableHead>{t('projects:colVersions')}</TableHead>
                      <TableHead>{t('projects:colEnvironments')}</TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((p) => (
                      <ProjectTableRow
                        key={p.id}
                        project={p}
                        expanded={expanded.has(p.id)}
                        onToggle={() => toggleExpanded(p.id)}
                        onEdit={() =>
                          setForm({
                            open: true,
                            mode: 'edit-project',
                            id: p.id,
                            name: p.name,
                            description: p.description ?? '',
                            repo: {
                              repoUrl: p.repoUrl ?? '',
                              provider: (p.provider as 'github' | 'gitee' | 'gitlab') ?? 'github',
                              gitlabUrlOverride: p.gitlabUrlOverride ?? '',
                              patOverride: '',
                              defaultBranch: p.defaultBranch ?? 'main',
                              hasPat: p.hasPat,
                            },
                          })
                        }
                        onDelete={() => setConfirmDelete({ id: p.id, name: p.name })}
                        onAddVersion={() =>
                          setVersionForm({
                            open: true,
                            mode: 'create',
                            projectId: p.id,
                            projectName: p.name,
                            versionId: null,
                            name: '',
                            description: '',
                            environmentId: '',
                          })
                        }
                        onEditVersion={(v) =>
                          setVersionForm({
                            open: true,
                            mode: 'edit',
                            projectId: p.id,
                            projectName: p.name,
                            versionId: v.id,
                            name: v.name,
                            description: v.description ?? '',
                            environmentId: v.environmentId ?? '',
                          })
                        }
                        onEnterVersion={(v) => enterVersion(p.id, p.name, v)}
                        onRemoveVersion={(v) => setConfirmDeleteVersion({ projectId: p.id, versionId: v.id, versionName: v.name })}
                        onEditVersionRef={(v) => setRefForm({ open: true, projectId: p.id, version: v })}
                        onOpenEnvironments={() => navigate(`/p/${p.id}/environments`)}
                        onOpenDatasets={() => navigate(`/p/${p.id}/datasets`)}
                        onOpenDeviceTargets={() => navigate(`/p/${p.id}/device-targets`)}
                      />
                    ))}
                  </TableBody>
                </Table>
                </div>
              </>
            )}
          </div>
        )}
      </PageShellContent>

      {/* 项目新建/编辑弹窗 */}
      <Dialog open={form.open} onOpenChange={(open) => setForm((f) => ({ ...f, open }))}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{form.mode === 'create-project' ? t('projects:createProject') : t('projects:editProject')}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 min-h-0 flex flex-col gap-3 px-5 py-4 overflow-y-auto">
            <Input label={t('projects:name')} placeholder={t('projects:namePlaceholder')} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-foreground)' }}>{t('projects:description')}</label>
              <textarea
                className="input-base"
                placeholder={t('projects:descriptionPlaceholder')}
                rows={2}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
            <RepoFields
              value={form.repo}
              onChange={(repo) => setForm((f) => ({ ...f, repo }))}
            />
          </div>
          <div
            className="flex justify-end gap-2 px-5 py-3 hairline-top shrink-0"
            style={{ borderColor: 'var(--border)' }}
          >
            <Button variant="ghost" onClick={() => setForm(EMPTY_FORM)}>{t('common:cancel')}</Button>
            <Button disabled={!form.name.trim() || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? t('common:saving') : t('common:save')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 版本新建/编辑弹窗 */}
      <Dialog open={versionForm.open} onOpenChange={(open) => setVersionForm((f) => ({ ...f, open }))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{versionForm.mode === 'create' ? t('projects:createVersion') : t('projects:editVersion')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <p className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
              {versionForm.mode === 'create'
                ? t('projects:versionCreateIntro', { project: versionForm.projectName })
                : t('projects:versionEditIntro', { project: versionForm.projectName })}
            </p>
            <Input
              label={t('projects:versionName')}
              placeholder={t('projects:versionNamePlaceholder')}
              value={versionForm.name}
              onChange={(e) => setVersionForm((f) => ({ ...f, name: e.target.value }))}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-foreground)' }}>{t('projects:versionEnvLabel')}</label>
              <select
                className="input-base input-sm"
                value={versionForm.environmentId}
                onChange={(e) => setVersionForm((f) => ({ ...f, environmentId: e.target.value }))}
              >
                <option value="">{t('projects:versionEnvNone')}</option>
                {(envsQ.data ?? []).map((env) => (
                  <option key={env.id} value={env.id}>
                    {env.name}{env.isDefault ? t('projects:envDefaultSuffix') : ''}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-foreground)' }}>{t('projects:description')}</label>
              <textarea
                className="input-base"
                placeholder={t('projects:versionDescriptionPlaceholder')}
                rows={3}
                value={versionForm.description}
                onChange={(e) => setVersionForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
          </div>
          <div
            className="flex justify-end gap-2 px-5 py-4 hairline-top"
            style={{ borderColor: 'var(--border)' }}
          >
            <Button variant="ghost" onClick={() => setVersionForm(EMPTY_VERSION_FORM)}>{t('common:cancel')}</Button>
            <Button
              disabled={
                !versionForm.name.trim() ||
                (versionForm.mode === 'create' ? createVersion.isPending : editVersion.isPending)
              }
              onClick={() => (versionForm.mode === 'create' ? createVersion.mutate() : editVersion.mutate())}
            >
              {versionForm.mode === 'create'
                ? createVersion.isPending ? t('projects:creating') : t('projects:create')
                : editVersion.isPending ? t('common:saving') : t('common:save')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 删除项目确认 */}
      <Dialog open={!!confirmDelete} onOpenChange={(open) => { if (!open) setConfirmDelete(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('projects:deleteProject')}</DialogTitle></DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
            {t('projects:deleteProjectConfirm', { name: confirmDelete?.name })}
          </div>
          <div
            className="flex justify-end gap-2 px-5 py-4 hairline-top"
            style={{ borderColor: 'var(--border)' }}
          >
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>{t('common:cancel')}</Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => confirmDelete && remove.mutate(confirmDelete.id)}
            >
              {remove.isPending ? t('projects:deleting') : t('projects:confirmDelete')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 删除版本确认:数据丢失风险最大,前端一律先弹再发请求 */}
      <Dialog open={!!confirmDeleteVersion} onOpenChange={(open) => { if (!open) setConfirmDeleteVersion(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('projects:deleteVersion')}</DialogTitle></DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
            {t('projects:deleteVersionConfirm', { versionName: confirmDeleteVersion?.versionName })}
          </div>
          <div
            className="flex justify-end gap-2 px-5 py-4 hairline-top"
            style={{ borderColor: 'var(--border)' }}
          >
            <Button variant="ghost" onClick={() => setConfirmDeleteVersion(null)}>{t('common:cancel')}</Button>
            <Button
              variant="danger"
              disabled={removeVersion.isPending}
              onClick={() => confirmDeleteVersion && removeVersion.mutate({ projectId: confirmDeleteVersion.projectId, versionId: confirmDeleteVersion.versionId })}
            >
              {removeVersion.isPending ? t('projects:deleting') : t('projects:confirmDelete')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 产品线新建/编辑弹窗 */}
      <Dialog open={!!lineDraft} onOpenChange={(o) => !o && setLineDraft(null)}>
        <DialogContent style={{ maxWidth: 520 }}>
          <DialogHeader>
            <DialogTitle>{lineEditingId ? t('productLines:editTitle') : t('productLines:createTitle')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <Input
              label={t('productLines:namePlaceholder')}
              value={lineDraft?.name ?? ''}
              onChange={(e) => setLineDraft((d) => d && { ...d, name: e.target.value })}
              placeholder={t('productLines:namePlaceholder')}
            />
            <Input
              label={t('productLines:descPlaceholder')}
              value={lineDraft?.description ?? ''}
              onChange={(e) => setLineDraft((d) => d && { ...d, description: e.target.value })}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setLineDraft(null)}>{t('productLines:cancel')}</Button>
            <Button
              disabled={!lineDraft?.name.trim() || saveLine.isPending}
              onClick={() => lineDraft && saveLine.mutate(lineDraft)}
            >
              {lineEditingId ? t('productLines:save') : t('productLines:create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 产品线成员管理：线内项目可摘除，未归线项目可勾选挂载 */}
      <Dialog open={!!manageLine} onOpenChange={(o) => !o && setManageLine(null)}>
        <DialogContent style={{ maxWidth: 520 }}>
          <DialogHeader>
            <DialogTitle>{t('productLines:manageProjects')} · {manageLine?.name}</DialogTitle>
          </DialogHeader>
          <div className="px-5 py-4 flex flex-col gap-4 max-h-[420px] overflow-y-auto">
            <div>
              <div className="text-[11px] font-medium uppercase tracking-[0.04em] mb-1" style={{ color: 'var(--muted-foreground)' }}>
                {t('productLines:membersTitle')}
              </div>
              {manageLineMembers.length === 0 ? (
                <div className="text-[12px] py-2" style={{ color: 'var(--muted-foreground)' }}>
                  {t('productLines:noProjects')}
                </div>
              ) : (
                manageLineMembers.map((p) => (
                  <div key={p.id} className="flex items-center gap-2 px-2 py-1.5">
                    <Icon name="folder" size={12} style={{ color: 'var(--muted-foreground)' }} />
                    <span className="text-[12px] flex-1 truncate">{p.name}</span>
                    {canManage && (
                      <IconButton
                        icon="close"
                        title={t('productLines:detachProject')}
                        disabled={detach.isPending}
                        onClick={() => manageLine && detach.mutate({ lineId: manageLine.id, projectId: p.id })}
                      />
                    )}
                  </div>
                ))
              )}
            </div>
            {attachable.length > 0 && (
              <div>
                <div className="text-[11px] font-medium uppercase tracking-[0.04em] mb-1" style={{ color: 'var(--muted-foreground)' }}>
                  {t('productLines:candidatesTitle')}
                </div>
                {attachable.map((p) => {
                  const checked = picked.has(p.id);
                  return (
                    <label
                      key={p.id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-sm)] cursor-pointer hover-card"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const next = new Set(picked);
                          if (checked) next.delete(p.id);
                          else next.add(p.id);
                          setPicked(next);
                        }}
                      />
                      <span className="text-[12px] flex-1 truncate">{p.name}</span>
                      {p.description && (
                        <span className="text-[10px] truncate max-w-[180px]" style={{ color: 'var(--muted-foreground)' }}>
                          {p.description}
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setManageLine(null)}>{t('productLines:cancel')}</Button>
            {canManage && attachable.length > 0 && (
              <Button
                disabled={picked.size === 0 || attach.isPending}
                onClick={() => manageLine && attach.mutate({ lineId: manageLine.id, ids: [...picked] })}
              >
                {t('productLines:attachProjects')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除产品线确认：项目退回「未归线」，跨项目用例随之失效 */}
      <Dialog open={!!confirmDeleteLine} onOpenChange={(o) => !o && setConfirmDeleteLine(null)}>
        <DialogContent style={{ maxWidth: 420 }}>
          <DialogHeader><DialogTitle>{t('productLines:deleteTitle')}</DialogTitle></DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--foreground)' }}>
            {t('productLines:deleteConfirm', { name: confirmDeleteLine?.name })}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDeleteLine(null)}>{t('productLines:cancel')}</Button>
            <Button
              variant="danger"
              disabled={removeLine.isPending}
              onClick={() => confirmDeleteLine && removeLine.mutate(confirmDeleteLine)}
            >
              {t('common:delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 版本 ref 编辑弹窗 */}
      <RefEditDialog
        state={refForm}
        onClose={() => setRefForm(EMPTY_REF_FORM)}
        onSubmit={(ref, refKind) => {
          if (refForm.version) {
            saveRef.mutate({ versionId: refForm.version.id, ref, refKind });
          }
        }}
        saving={saveRef.isPending}
      />
    </PageShell>
  );
}

interface ProjectTableRowProps {
  project: {
    id: string;
    name: string;
    description: string | null;
    productLineId?: string | null;
    productLineName?: string | null;
    caseCount: number;
    versionCount: number;
    environmentCount: number;
    repoUrl: string | null;
  };
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onAddVersion: () => void;
  onEditVersion: (v: ProjectVersion) => void;
  onEnterVersion: (v: ProjectVersion) => void;
  onRemoveVersion: (v: ProjectVersion) => void;
  onEditVersionRef: (v: ProjectVersion) => void;
  onOpenEnvironments: () => void;
  onOpenDatasets: () => void;
  onOpenDeviceTargets: () => void;
}

/** 平铺表的一行：主行（项目/归属/计数/操作）+ 展开行（版本管理面板）。 */
function ProjectTableRow({
  project: p,
  expanded,
  onToggle,
  onEdit,
  onDelete,
  onAddVersion,
  onEditVersion,
  onEnterVersion,
  onRemoveVersion,
  onEditVersionRef,
  onOpenEnvironments,
  onOpenDatasets,
  onOpenDeviceTargets,
}: ProjectTableRowProps) {
  const { t } = useTranslation();
  return (
    <>
      <TableRow
        data-stagger-item
        aria-expanded={expanded}
        onClick={onToggle}
        className="cursor-pointer"
      >
        <TableCell className="pl-3">
          <div className="flex items-center gap-2 min-w-0">
            <Icon
              name={expanded ? 'chevronDown' : 'chevronRight'}
              size={12}
              className="shrink-0"
              style={{ color: 'var(--muted-foreground)' }}
            />
            <Icon name="folder" size={14} className="shrink-0" style={{ color: 'var(--muted-foreground)' }} />
            <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--foreground)' }}>
              {p.name}
            </span>
            {p.description && (
              <span className="text-[12px] truncate hidden md:inline max-w-[320px]" style={{ color: 'var(--muted-foreground)' }}>
                {p.description}
              </span>
            )}
          </div>
        </TableCell>
        <TableCell>
          {p.productLineId ? (
            <span
              className="text-[10px] font-semibold px-1.5 py-[1px] rounded whitespace-nowrap"
              style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}
            >
              {p.productLineName ?? p.productLineId.slice(0, 8)}
            </span>
          ) : (
            <span
              className="text-[10px] font-semibold px-1.5 py-[1px] rounded whitespace-nowrap"
              style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}
            >
              {t('productLines:unassigned')}
            </span>
          )}
        </TableCell>
        <TableCell className="text-[12px] tabular-nums" style={{ color: 'var(--muted-foreground)' }}>{p.caseCount}</TableCell>
        <TableCell className="text-[12px] tabular-nums" style={{ color: 'var(--muted-foreground)' }}>{p.versionCount}</TableCell>
        <TableCell className="text-[12px] tabular-nums" style={{ color: 'var(--muted-foreground)' }}>{p.environmentCount}</TableCell>
        <TableCell onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-1">
            <IconButton icon="pencil" title={t('projects:editProject')} onClick={onEdit} />
            <IconButton icon="database" title={t('projects:manageEnvironments')} onClick={onOpenEnvironments} />
            <IconButton icon="table" title={t('projects:datasets')} onClick={onOpenDatasets} />
            <IconButton icon="tablet" title={t('projects:deviceTargets')} onClick={onOpenDeviceTargets} />
            <IconButton icon="trash" title={t('projects:deleteProject')} tone="destructive" onClick={onDelete} />
          </div>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={6} className="p-0">
            <VersionPanel
              projectId={p.id}
              repoUrl={p.repoUrl}
              onAddVersion={onAddVersion}
              onEditVersion={onEditVersion}
              onEnterVersion={onEnterVersion}
              onRemoveVersion={onRemoveVersion}
              onEditVersionRef={onEditVersionRef}
            />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

interface VersionPanelProps {
  projectId: string;
  repoUrl: string | null;
  onAddVersion: () => void;
  onEditVersion: (v: ProjectVersion) => void;
  onEnterVersion: (v: ProjectVersion) => void;
  onRemoveVersion: (v: ProjectVersion) => void;
  onEditVersionRef: (v: ProjectVersion) => void;
}

/** 展开行内的版本面板（沿用旧 ProjectRow 展开区：版本列表 + 进入/ref/增删）。 */
function VersionPanel({
  projectId,
  repoUrl,
  onAddVersion,
  onEditVersion,
  onEnterVersion,
  onRemoveVersion,
  onEditVersionRef,
}: VersionPanelProps) {
  const { t } = useTranslation();
  const versionsQ = useQuery({
    queryKey: ['versions', projectId],
    queryFn: () => api.versions.list(projectId),
  });
  // 版本行「打开环境域名」取自环境 web 服务 origin；展开时拉一次（与版本弹窗共享缓存）
  const envsQ = useQuery({
    queryKey: ['environments', projectId],
    queryFn: () => api.environments.list(projectId),
  });

  return (
    <div className="px-3 py-3" style={{ background: 'var(--muted)' }}>
      {versionsQ.isLoading ? (
        <div className="flex items-center gap-2 px-3 py-3 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
          <Icon name="loader" size={14} className="animate-spin" />
          {t('projects:loadingVersions')}
        </div>
      ) : versionsQ.isError ? (
        <div className="px-3 py-3 text-[12px]" style={{ color: 'var(--destructive)' }}>
          {t('common:loadFailed')}：{(versionsQ.error as Error | null)?.message ?? t('common:unknownError')}
        </div>
      ) : (
        <div
          className="rounded-[var(--radius-sm)] overflow-hidden"
          style={{ border: '1px solid var(--border)', background: 'var(--card)' }}
        >
          {(versionsQ.data ?? []).length === 0 ? (
            <div className="px-3 py-3 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
              {t('projects:noVersions')}
            </div>
          ) : (
            <ul>
              {(versionsQ.data ?? []).map((v) => {
                // 版本显式绑定的环境优先，未绑定走项目默认环境（与执行期解析一致）
                const envs = envsQ.data ?? [];
                const env = envs.find((e) => e.id === v.environmentId) ?? envs.find((e) => e.isDefault);
                // 「打开环境域名」取自环境 web 服务 origin（优先默认服务）
                const envUrl = (() => {
                  const web = env?.objects.find((o) => o.objectType === 'web' && o.isDefault)
                    ?? env?.objects.find((o) => o.objectType === 'web');
                  const pp = (web?.payload ?? {}) as { scheme?: string; host?: string; port?: number };
                  if (!pp.host) return null;
                  return `${pp.scheme === 'https' ? 'https' : 'http'}://${pp.host}${pp.port != null ? `:${pp.port}` : ''}`;
                })();
                return (
                  <li
                    key={v.id}
                    className="flex items-center gap-3 px-3 py-2 list-row-clickable"
                    style={{ borderBottom: '1px solid var(--muted)' }}
                  >
                    <Icon name="tag" size={12} style={{ color: 'var(--muted-foreground)', flexShrink: 0 }} />
                    <span className="text-[13px] font-medium" style={{ color: 'var(--foreground)' }}>
                      {v.name}
                    </span>
                    <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                      {t('projects:versionStats', { cases: v.caseCount ?? 0, plans: v.planCount ?? 0 })}
                    </span>
                    <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                      {t('projects:versionEnv', { env: v.environmentName ?? t('projects:projectDefault') })}
                    </span>
                    {v.ref && v.refKind && (
                      <span
                        className="text-[10px] px-1.5 py-[1px] rounded"
                        style={{
                          background: 'var(--card)',
                          border: '1px solid var(--border)',
                          color: 'var(--muted-foreground)',
                        }}
                        title={t('projects:boundGit', { kind: v.refKind })}
                      >
                        {v.refKind === 'branch' ? '⎇' : '⌖'} {v.ref}
                      </span>
                    )}
                    <div className="flex-1" />
                    <div className="flex items-center gap-1">
                      <IconButton icon="pencil" title={t('projects:editVersion')} onClick={() => onEditVersion(v)} />
                      <IconButton
                        icon="gitBranch"
                        title={repoUrl ? t('projects:setBranch') : t('projects:configureRepoFirst')}
                        onClick={() => onEditVersionRef(v)}
                        disabled={!repoUrl}
                      />
                      <IconButton
                        icon="externalLink"
                        title={envUrl ? t('projects:openEnv', { url: envUrl }) : t('projects:envNoDomain')}
                        onClick={() => envUrl && window.open(envUrl, '_blank', 'noopener')}
                        disabled={!envUrl}
                      />
                      <IconButton icon="trash" title={t('projects:deleteVersion')} tone="destructive" onClick={() => onRemoveVersion(v)} />
                      <Button size="sm" onClick={() => onEnterVersion(v)}>
                        {t('projects:enter')}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex items-center px-3 py-2" style={{ background: 'var(--muted)' }}>
            <button
              type="button"
              onClick={onAddVersion}
              className="flex items-center gap-1.5 text-[12px]"
              style={{ background: 'transparent', border: 'none', color: 'var(--primary)', cursor: 'pointer', padding: 0 }}
            >
              <Icon name="plus" size={12} />
              {t('projects:addVersion')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
