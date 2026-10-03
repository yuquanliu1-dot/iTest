import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type ProjectVersion } from '../api/client';
import { useProjectStore } from '../stores/project';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import IconButton from '../components/ui/IconButton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/Modal';
import Input from '../components/ui/Input';
import Button from '../components/ui/Button';
import RefEditDialog, { EMPTY_REF_FORM, type RefFormState } from '../components/version/RefEditDialog';
import VersionDbConfigDialog from '../components/version/VersionDbConfigDialog';
import VersionSyslogConfigDialog from '../components/version/VersionSyslogConfigDialog';

interface VersionFormState {
  open: boolean;
  mode: 'create' | 'edit';
  versionId: string | null;
  name: string;
  description: string;
}

const EMPTY_VERSION_FORM: VersionFormState = {
  open: false,
  mode: 'create',
  versionId: null,
  name: '',
  description: '',
};

/** 选版本中间页 + 行内版本管理入口。路径 /p/:projectId/versions/select
 *  - 卡片展示版本信息，底部操作行：编辑 / ref / 默认 / 删除 / DB / syslog / 进入
 *  - store 里的 versionId/versionName 在「进入」时落定，之后 ProjectGuard 直接放行 */
export default function VersionsSelectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const enter = useProjectStore((s) => s.enter);
  const switchVersion = useProjectStore((s) => s.switchVersion);
  const current = useProjectStore((s) => s.current);
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['versions', projectId],
    queryFn: () => api.versions.list(projectId!),
    enabled: !!projectId,
  });
  // 项目级信息：取 repoUrl 用来判断 ref 按钮是否可用
  const projectsQ = useQuery({
    queryKey: ['projects'],
    queryFn: api.projects.list,
  });
  const project = projectsQ.data?.find((p) => p.id === projectId);

  useEffect(() => {
    if (!projectId) return;
    if (!current || current.id !== projectId) {
      navigate('/', { replace: true });
    }
  }, [projectId, current, navigate]);

  // ----- 行内状态 -----
  const [versionForm, setVersionForm] = useState<VersionFormState>(EMPTY_VERSION_FORM);
  const [refForm, setRefForm] = useState<RefFormState>(EMPTY_REF_FORM);
  const [dbTarget, setDbTarget] = useState<ProjectVersion | null>(null);
  const [syslogTarget, setSyslogTarget] = useState<ProjectVersion | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ProjectVersion | null>(null);

  // ----- mutations -----
  const editVersion = useMutation({
    mutationFn: () =>
      api.versions.patch(versionForm.versionId!, {
        name: versionForm.name.trim(),
        description: versionForm.description.trim() ? versionForm.description.trim() : null,
      }),
    onSuccess: () => {
      toast('版本已更新', 'success');
      setVersionForm(EMPTY_VERSION_FORM);
      qc.invalidateQueries({ queryKey: ['versions', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const setDefaultVersion = useMutation({
    mutationFn: (versionId: string) => api.versions.setDefault(projectId!, versionId),
    onSuccess: () => {
      toast('默认版本已更新', 'success');
      qc.invalidateQueries({ queryKey: ['versions', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const removeVersion = useMutation({
    mutationFn: (versionId: string) => api.versions.remove(projectId!, versionId),
    onSuccess: () => {
      toast('版本已删除', 'success');
      setConfirmDelete(null);
      qc.invalidateQueries({ queryKey: ['versions', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const saveRef = useMutation({
    mutationFn: ({ versionId, ref, refKind }: { versionId: string; ref: string | null; refKind: 'branch' | 'tag' | null }) =>
      api.versions.setRef(versionId, { ref, refKind }),
    onSuccess: () => {
      toast('已保存', 'success');
      setRefForm(EMPTY_REF_FORM);
      qc.invalidateQueries({ queryKey: ['versions', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)', fontSize: 13 }}>
        <Icon name="loader" size={16} className="animate-spin" />
        <span style={{ marginLeft: 8 }}>加载中...</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)', fontSize: 13 }}>
        加载失败：{(error as Error)?.message ?? '未知错误'}
      </div>
    );
  }

  const versions: ProjectVersion[] = data ?? [];

  const pick = (v: ProjectVersion) => {
    if (!projectId) return;
    switchVersion(v.id, v.name);
    navigate(`/p/${projectId}/v/${v.id}/overview`);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-6 pt-5 pb-2">
        <div>
          <h1 className="text-[20px] font-bold tracking-tight" style={{ color: 'var(--color-foreground)' }}>
            选择版本
          </h1>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--color-foreground-muted)' }}>
            {current?.name ?? ''} · {versions.length} 个版本
          </p>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
        {versions.length === 0 ? (
          <div className="text-[13px]" style={{ color: 'var(--color-foreground-muted)' }}>
            暂无版本
          </div>
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
            {versions.map((v) => (
              <div
                key={v.id}
                className="press"
                onDoubleClick={() => pick(v)}
                style={{
                  padding: '14px 16px',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--color-surface-elevated)',
                  border: '1px solid var(--color-glass-panel-border)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  cursor: 'pointer',
                  position: 'relative',
                }}
              >
                <div onClick={() => pick(v)} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div className="flex items-center gap-2">
                    <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-foreground)' }}>
                      {v.name}
                    </span>
                    {v.isDefault && (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          letterSpacing: '0.04em',
                          textTransform: 'uppercase',
                          padding: '2px 6px',
                          borderRadius: 999,
                          background: 'var(--color-accent-soft)',
                          color: 'var(--color-accent)',
                        }}
                      >
                        默认
                      </span>
                    )}
                    {v.ref && v.refKind && (
                      <span
                        style={{
                          fontSize: 10,
                          padding: '2px 6px',
                          borderRadius: 'var(--radius-sm)',
                          background: 'var(--color-background-subtle)',
                          border: '1px solid var(--color-glass-border)',
                          color: 'var(--color-foreground-secondary)',
                        }}
                        title={`绑定的 git ${v.refKind}`}
                      >
                        {v.refKind === 'branch' ? '⎇' : '⌖'} {v.ref}
                      </span>
                    )}
                  </div>
                  {v.description && (
                    <div className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>
                      {v.description}
                    </div>
                  )}
                  <div className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
                    用例 {v.caseCount ?? 0} · 环境 {v.environmentCount ?? 0} · 计划 {v.planCount ?? 0}
                  </div>
                </div>
                <div
                  className="flex items-center gap-1 mt-1"
                  style={{ borderTop: '1px solid var(--color-muted)', paddingTop: 8 }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <IconButton icon="pencil" title="编辑版本" onClick={() => setVersionForm({ open: true, mode: 'edit', versionId: v.id, name: v.name, description: v.description ?? '' })} />
                  <IconButton
                    icon="gitBranch"
                    title={project?.repoUrl ? '编辑 ref' : '请先在项目页配置仓库'}
                    disabled={!project?.repoUrl}
                    onClick={() => setRefForm({ open: true, projectId: projectId!, version: v })}
                  />
                  {!v.isDefault && (
                    <IconButton icon="star" title="设为默认" onClick={() => setDefaultVersion.mutate(v.id)} />
                  )}
                  <IconButton icon="trash" title="删除版本" tone="destructive" onClick={() => setConfirmDelete(v)} />
                  <span style={{ width: 1, height: 16, background: 'var(--color-muted)', margin: '0 4px' }} />
                  <IconButton icon="database" title="数据库配置" onClick={() => setDbTarget(v)} />
                  <IconButton icon="terminal" title="syslog 配置" onClick={() => setSyslogTarget(v)} />
                  <div style={{ flex: 1 }} />
                  <Button size="sm" onClick={() => pick(v)}>进入</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 版本编辑 */}
      <Dialog open={versionForm.open} onOpenChange={(o) => setVersionForm((f) => ({ ...f, open: o }))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑版本</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <Input
              label="版本名"
              value={versionForm.name}
              onChange={(e) => setVersionForm((f) => ({ ...f, name: e.target.value }))}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-foreground-secondary)' }}>描述（可空）</label>
              <textarea
                className="input-base"
                rows={3}
                value={versionForm.description}
                onChange={(e) => setVersionForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
          </div>
          <div
            className="flex justify-end gap-2 px-5 py-3 hairline-top shrink-0"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <Button variant="ghost" onClick={() => setVersionForm(EMPTY_VERSION_FORM)}>取消</Button>
            <Button
              disabled={!versionForm.name.trim() || editVersion.isPending}
              onClick={() => editVersion.mutate()}
            >
              {editVersion.isPending ? '保存中...' : '保存'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 版本 ref */}
      <RefEditDialog
        state={refForm}
        onClose={() => setRefForm(EMPTY_REF_FORM)}
        onSubmit={(ref, refKind) => {
          if (refForm.version) saveRef.mutate({ versionId: refForm.version.id, ref, refKind });
        }}
        saving={saveRef.isPending}
      />

      {/* 数据库配置 */}
      {dbTarget && (
        <VersionDbConfigDialog
          open={!!dbTarget}
          projectId={projectId!}
          versionId={dbTarget.id}
          versionName={dbTarget.name}
          onClose={() => setDbTarget(null)}
        />
      )}

      {/* syslog 配置 */}
      {syslogTarget && (
        <VersionSyslogConfigDialog
          open={!!syslogTarget}
          projectId={projectId!}
          versionId={syslogTarget.id}
          versionName={syslogTarget.name}
          onClose={() => setSyslogTarget(null)}
        />
      )}

      {/* 删除确认 */}
      <Dialog open={!!confirmDelete} onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>删除版本</DialogTitle></DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--color-foreground-secondary)' }}>
            确定删除「{confirmDelete?.name}」？引用此版本的用例与计划将被解除绑定。
          </div>
          <div
            className="flex justify-end gap-2 px-5 py-3 hairline-top shrink-0"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>取消</Button>
            <Button
              variant="danger"
              disabled={removeVersion.isPending}
              onClick={() => confirmDelete && removeVersion.mutate(confirmDelete.id)}
            >
              {removeVersion.isPending ? '删除中...' : '确认删除'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}