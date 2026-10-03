import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type ProjectVersion } from '../api/client';
import { useProjectStore } from '../stores/project';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import EmptyState from '../components/ui/EmptyState';
import IconButton from '../components/ui/IconButton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/Modal';
import Input from '../components/ui/Input';
import Button from '../components/ui/Button';
import RepoFields, { EMPTY_REPO, type RepoFieldsValue } from '../components/ui/RepoFields';
import RefEditDialog, { EMPTY_REF_FORM, type RefFormState } from '../components/version/RefEditDialog';

interface FormState {
  open: boolean;
  mode: 'create-project' | 'edit-project';
  id: string | null;
  name: string;
  description: string;
  defaultUrl: string;
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
  defaultUrl: string;
  /** 当前所属项目的 defaultUrl，作为版本留空时的回退占位提示用 */
  projectDefaultUrl: string | null;
}

const EMPTY_FORM: FormState = {
  open: false,
  mode: 'create-project',
  id: null,
  name: '',
  description: '',
  defaultUrl: '',
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
  defaultUrl: '',
  projectDefaultUrl: null,
};

export default function ProjectsHome() {
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const enter = useProjectStore((s) => s.enter);
  const switchVersion = useProjectStore((s) => s.switchVersion);
  const { data, isLoading } = useQuery({ queryKey: ['projects'], queryFn: api.projects.list });
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [versionForm, setVersionForm] = useState<VersionFormState>(EMPTY_VERSION_FORM);
  const [refForm, setRefForm] = useState<RefFormState>(EMPTY_REF_FORM);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  // 展开状态：默认全部收起，避免大量项目时首屏刷屏
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = useMutation({
    mutationFn: async () => {
      const r = form.repo;
      const baseBody = {
        name: form.name,
        description: form.description || undefined,
        defaultUrl: form.defaultUrl || undefined,
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
      toast(form.mode === 'create-project' ? '项目已创建' : '项目已更新', 'success');
      setForm(EMPTY_FORM);
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.projects.remove(id),
    onSuccess: () => {
      toast('项目已删除', 'success');
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
      toast(e.message.includes('409') || e.message.includes('cases') ? '项目内仍有用例，请先清空再删除' : e.message, 'error');
      setConfirmDelete(null);
    },
  });

  const createVersion = useMutation({
    mutationFn: () =>
      api.versions.create(versionForm.projectId, {
        name: versionForm.name,
        description: versionForm.description || undefined,
        defaultUrl: versionForm.defaultUrl.trim() || undefined,
      }),
    onSuccess: (v) => {
      toast(`已新建版本 ${v.name}`, 'success');
      setVersionForm(EMPTY_VERSION_FORM);
      qc.invalidateQueries({ queryKey: ['versions', versionForm.projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const editVersion = useMutation({
    mutationFn: () =>
      api.versions.patch(versionForm.versionId!, {
        name: versionForm.name.trim(),
        description: versionForm.description.trim() ? versionForm.description.trim() : null,
        defaultUrl: versionForm.defaultUrl.trim() ? versionForm.defaultUrl.trim() : null,
      }),
    onSuccess: (v) => {
      toast(`已更新版本 ${v.name}`, 'success');
      setVersionForm(EMPTY_VERSION_FORM);
      qc.invalidateQueries({ queryKey: ['versions', versionForm.projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const setDefaultVersion = useMutation({
    mutationFn: ({ projectId, versionId }: { projectId: string; versionId: string }) =>
      api.versions.setDefault(projectId, versionId),
    onSuccess: () => {
      toast('默认版本已更新', 'success');
      qc.invalidateQueries({ queryKey: ['versions'] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const removeVersion = useMutation({
    mutationFn: ({ projectId, versionId }: { projectId: string; versionId: string }) =>
      api.versions.remove(projectId, versionId),
    onSuccess: () => {
      toast('版本已删除', 'success');
      qc.invalidateQueries({ queryKey: ['versions'] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const saveRef = useMutation({
    mutationFn: ({ versionId, ref, refKind }: { versionId: string; ref: string | null; refKind: 'branch' | 'tag' | null }) =>
      api.versions.setRef(versionId, { ref, refKind }),
    onSuccess: () => {
      toast('已保存', 'success');
      setRefForm(EMPTY_REF_FORM);
      qc.invalidateQueries({ queryKey: ['versions'] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const enterVersion = (projectId: string, projectName: string, projectDefaultUrl: string | null, v: ProjectVersion) => {
    enter({ id: projectId, name: projectName, defaultUrl: projectDefaultUrl, versionId: v.id, versionName: v.name });
    switchVersion(v.id, v.name);
    navigate(`/p/${projectId}/v/${v.id}/overview`);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-5 pt-4 pb-0">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight" style={{ color: 'var(--color-foreground)' }}>
            项目
          </h1>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--color-foreground-muted)' }}>
            选择一个项目进入工作区，或创建新项目
          </p>
        </div>
        <Button
          onClick={() =>
            setForm({
              open: true,
              mode: 'create-project',
              id: null,
              name: '',
              description: '',
              defaultUrl: '',
              repo: EMPTY_REPO,
            })
          }
        >
          <Icon name="plus" size={14} />
          新建项目
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
        {isLoading ? (
          <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)', fontSize: 13 }}>
            <Icon name="loader" size={16} className="animate-spin" />
            <span style={{ marginLeft: 8 }}>加载中...</span>
          </div>
        ) : (data ?? []).length === 0 ? (
          <EmptyState icon="layers" title="还没有项目" description="创建第一个项目，开始组织测试资产。" />
        ) : (
          <div className="flex flex-col" data-stagger>
            {(data ?? []).map((p) => (
              <ProjectRow
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
                    defaultUrl: p.defaultUrl ?? '',
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
                    defaultUrl: '',
                    projectDefaultUrl: p.defaultUrl,
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
                    defaultUrl: v.defaultUrl ?? '',
                    projectDefaultUrl: p.defaultUrl,
                  })
                }
                onEnterVersion={(v) => enterVersion(p.id, p.name, p.defaultUrl, v)}
                onSetDefaultVersion={(v) => setDefaultVersion.mutate({ projectId: p.id, versionId: v.id })}
                onRemoveVersion={(v) => removeVersion.mutate({ projectId: p.id, versionId: v.id })}
                onEditVersionRef={(v) => setRefForm({ open: true, projectId: p.id, version: v })}
              />
            ))}
          </div>
        )}
      </div>

      {/* 项目新建/编辑弹窗 */}
      <Dialog open={form.open} onOpenChange={(open) => setForm((f) => ({ ...f, open }))}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{form.mode === 'create-project' ? '新建项目' : '编辑项目'}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 min-h-0 flex flex-col gap-3 px-5 py-4 overflow-y-auto">
            <Input label="名称" placeholder="如：CueCast 官网" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            <Input
              label="默认域名（可空）"
              placeholder="https://example.com"
              value={form.defaultUrl}
              onChange={(e) => setForm((f) => ({ ...f, defaultUrl: e.target.value }))}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-foreground-secondary)' }}>描述（可空）</label>
              <textarea
                className="input-base"
                placeholder="简要说明项目用途"
                rows={2}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
            <RepoFields
              value={form.repo}
              onChange={(repo) => setForm((f) => ({ ...f, repo }))}
              projectNameHint={form.name.trim() || undefined}
            />
          </div>
          <div
            className="flex justify-end gap-2 px-5 py-3 hairline-top shrink-0"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <Button variant="ghost" onClick={() => setForm(EMPTY_FORM)}>取消</Button>
            <Button disabled={!form.name.trim() || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? '保存中...' : '保存'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 版本新建/编辑弹窗 */}
      <Dialog open={versionForm.open} onOpenChange={(open) => setVersionForm((f) => ({ ...f, open }))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{versionForm.mode === 'create' ? '新建版本' : '编辑版本'}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <p className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>
              {versionForm.mode === 'create' ? '为' : '编辑「'}{versionForm.projectName}{versionForm.mode === 'create' ? '」添加新版本' : '」'}
            </p>
            <Input
              label="版本名"
              placeholder="如：v1.0、需求-0421"
              value={versionForm.name}
              onChange={(e) => setVersionForm((f) => ({ ...f, name: e.target.value }))}
            />
            <Input
              label="默认域名（可空，留空走项目级）"
              placeholder={versionForm.projectDefaultUrl ?? 'https://example.com'}
              value={versionForm.defaultUrl}
              onChange={(e) => setVersionForm((f) => ({ ...f, defaultUrl: e.target.value }))}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-foreground-secondary)' }}>描述（可空）</label>
              <textarea
                className="input-base"
                placeholder="如：双十一大促版本"
                rows={3}
                value={versionForm.description}
                onChange={(e) => setVersionForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
          </div>
          <div
            className="flex justify-end gap-2 px-5 py-4 hairline-top"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <Button variant="ghost" onClick={() => setVersionForm(EMPTY_VERSION_FORM)}>取消</Button>
            <Button
              disabled={
                !versionForm.name.trim() ||
                (versionForm.mode === 'create' ? createVersion.isPending : editVersion.isPending)
              }
              onClick={() => (versionForm.mode === 'create' ? createVersion.mutate() : editVersion.mutate())}
            >
              {versionForm.mode === 'create'
                ? createVersion.isPending ? '创建中...' : '创建'
                : editVersion.isPending ? '保存中...' : '保存'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 删除项目确认 */}
      <Dialog open={!!confirmDelete} onOpenChange={(open) => { if (!open) setConfirmDelete(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>删除项目</DialogTitle></DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--color-foreground-secondary)' }}>
            确定删除「{confirmDelete?.name}」？项目内存在用例时将被拒绝删除。
          </div>
          <div
            className="flex justify-end gap-2 px-5 py-4 hairline-top"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>取消</Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => confirmDelete && remove.mutate(confirmDelete.id)}
            >
              {remove.isPending ? '删除中...' : '确认删除'}
            </Button>
          </div>
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
    </div>
  );
}

interface ProjectRowProps {
  project: { id: string; name: string; description: string | null; defaultUrl: string | null; caseCount: number; repoUrl: string | null };
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onAddVersion: () => void;
  onEditVersion: (v: ProjectVersion) => void;
  onEnterVersion: (v: ProjectVersion) => void;
  onSetDefaultVersion: (v: ProjectVersion) => void;
  onRemoveVersion: (v: ProjectVersion) => void;
  onEditVersionRef: (v: ProjectVersion) => void;
}

function ProjectRow({
  project: p,
  expanded,
  onToggle,
  onEdit,
  onDelete,
  onAddVersion,
  onEditVersion,
  onEnterVersion,
  onSetDefaultVersion,
  onRemoveVersion,
  onEditVersionRef,
}: ProjectRowProps) {
  const versionsQ = useQuery({
    queryKey: ['versions', p.id],
    queryFn: () => api.versions.list(p.id),
    enabled: expanded,
  });

  return (
    <div
      data-stagger-item
      className="hairline-bottom"
      style={{ borderColor: 'var(--color-muted)' }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
        className="flex items-center gap-3 px-3 py-3 cursor-pointer"
        style={{
          background: expanded ? 'var(--color-background-subtle)' : 'transparent',
          transition: 'background 120ms ease',
        }}
      >
        <Icon
          name={expanded ? 'chevronDown' : 'chevronRight'}
          size={12}
          style={{ color: 'var(--color-foreground-muted)', flexShrink: 0 }}
        />
        <div className="flex-1 min-w-0 flex items-center gap-3">
          <span className="text-[14px] font-semibold truncate" style={{ color: 'var(--color-foreground)' }}>
            {p.name}
          </span>
          {p.description && (
            <span className="text-[12px] truncate hidden sm:inline" style={{ color: 'var(--color-foreground-secondary)' }}>
              {p.description}
            </span>
          )}
        </div>
        <span className="text-[12px] shrink-0" style={{ color: 'var(--color-foreground-muted)' }}>
          {p.caseCount} 条用例
        </span>
        <span className="text-[12px] shrink-0 hidden md:inline" style={{ color: 'var(--color-foreground-muted)' }}>
          {p.defaultUrl ?? '未设置域名'}
        </span>
        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          <IconButton icon="pencil" title="编辑项目" onClick={onEdit} />
          <IconButton icon="trash" title="删除项目" tone="destructive" onClick={onDelete} />
        </div>
      </div>

      {expanded && (
        <div className="px-3 pb-3">
          {versionsQ.isLoading ? (
            <div className="flex items-center gap-2 px-3 py-3 text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>
              <Icon name="loader" size={14} className="animate-spin" />
              加载版本…
            </div>
          ) : versionsQ.isError ? (
            <div className="px-3 py-3 text-[12px]" style={{ color: 'var(--color-destructive)' }}>
              加载失败：{(versionsQ.error as Error | null)?.message ?? '未知错误'}
            </div>
          ) : (
            <div
              className="rounded-[var(--radius-sm)] overflow-hidden"
              style={{ border: '1px solid var(--color-glass-border)', background: 'var(--color-surface-elevated)' }}
            >
              {(versionsQ.data ?? []).length === 0 ? (
                <div className="px-3 py-3 text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>
                  暂无版本
                </div>
              ) : (
                <ul>
                  {(versionsQ.data ?? []).map((v) => (
                    <li
                      key={v.id}
                      className="flex items-center gap-3 px-3 py-2 list-row-clickable"
                      style={{ borderBottom: '1px solid var(--color-muted)' }}
                    >
                      <Icon name="tag" size={12} style={{ color: 'var(--color-foreground-muted)', flexShrink: 0 }} />
                      <span className="text-[13px] font-medium" style={{ color: 'var(--color-foreground)' }}>
                        {v.name}
                      </span>
                      {v.isDefault && (
                        <span
                          className="text-[10px] font-semibold uppercase px-1.5 py-[1px] rounded"
                          style={{
                            background: 'var(--color-accent-soft)',
                            color: 'var(--color-accent)',
                            letterSpacing: '0.04em',
                          }}
                        >
                          默认
                        </span>
                      )}
                      <span className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
                        用例 {v.caseCount ?? 0} · 环境 {v.environmentCount ?? 0} · 计划 {v.planCount ?? 0}
                      </span>
                      {v.ref && v.refKind && (
                        <span
                          className="text-[10px] px-1.5 py-[1px] rounded"
                          style={{
                            background: 'var(--color-surface-elevated)',
                            border: '1px solid var(--color-glass-border)',
                            color: 'var(--color-foreground-secondary)',
                          }}
                          title={`绑定的 git ${v.refKind}`}
                        >
                          {v.refKind === 'branch' ? '⎇' : '⌖'} {v.ref}
                        </span>
                      )}
                      <div className="flex-1" />
                      <div className="flex items-center gap-1">
                        <IconButton icon="pencil" title="编辑版本" onClick={() => onEditVersion(v)} />
                        <IconButton
                          icon="gitBranch"
                          title={p.repoUrl ? '编辑 ref' : '请先配置仓库'}
                          onClick={() => onEditVersionRef(v)}
                          disabled={!p.repoUrl}
                        />
                        {!v.isDefault && (
                          <IconButton icon="star" title="设为默认" onClick={() => onSetDefaultVersion(v)} />
                        )}
                        <IconButton icon="trash" title="删除版本" tone="destructive" onClick={() => onRemoveVersion(v)} />
                        <Button size="sm" onClick={() => onEnterVersion(v)}>
                          进入
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-center px-3 py-2" style={{ background: 'var(--color-background-subtle)' }}>
                <button
                  type="button"
                  onClick={onAddVersion}
                  className="flex items-center gap-1.5 text-[12px]"
                  style={{ background: 'transparent', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', padding: 0 }}
                >
                  <Icon name="plus" size={12} />
                  添加版本
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}