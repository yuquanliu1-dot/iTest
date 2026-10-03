import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type ProjectVersion } from '../api/client';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/Modal';

/** 版本管理页。路径 /p/:projectId/versions
 *  列表 + 建/设默认/删/改 ref；删除最后版本被拒；删除非空版本展示计数。 */
export default function ProjectVersionsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['versions', projectId],
    queryFn: () => api.versions.list(projectId!),
    enabled: !!projectId,
  });

  const projectQ = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.projects.get(projectId!),
    enabled: !!projectId,
  });

  const [form, setForm] = useState<{ name: string; description: string }>({ name: '', description: '' });
  const [busy, setBusy] = useState(false);
  const [refForm, setRefForm] = useState<{ open: boolean; version: ProjectVersion | null }>({ open: false, version: null });

  const create = useMutation({
    mutationFn: (body: { name: string; description?: string }) => api.versions.create(projectId!, body),
    onSuccess: () => {
      toast('版本已创建', 'success');
      setForm({ name: '', description: '' });
      qc.invalidateQueries({ queryKey: ['versions', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const setDefault = useMutation({
    mutationFn: (id: string) => api.versions.setDefault(projectId!, id),
    onSuccess: () => {
      toast('已设为默认版本', 'success');
      qc.invalidateQueries({ queryKey: ['versions', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.versions.remove(projectId!, id),
    onSuccess: () => {
      toast('已删除', 'success');
      qc.invalidateQueries({ queryKey: ['versions', projectId] });
    },
    onError: (e: Error & { status?: number }) => {
      const msg = e.message.includes('last_version')
        ? '无法删除项目最后一个版本'
        : e.message.includes('version_not_empty')
        ? '版本内仍有用例/环境/计划，请先迁移或删除'
        : e.message;
      toast(msg, 'error');
    },
  });

  const saveRef = useMutation({
    mutationFn: ({ versionId, ref, refKind }: { versionId: string; ref: string | null; refKind: 'branch' | 'tag' | null }) =>
      api.versions.setRef(versionId, { ref, refKind }),
    onSuccess: () => {
      toast('已保存', 'success');
      setRefForm({ open: false, version: null });
      qc.invalidateQueries({ queryKey: ['versions', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const versions: ProjectVersion[] = data ?? [];
  const project = projectQ.data;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-6 pt-5 pb-2">
        <div>
          <h1 className="text-[20px] font-bold tracking-tight" style={{ color: 'var(--color-foreground)' }}>
            版本管理
          </h1>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--color-foreground-muted)' }}>
            {versions.length} 个版本 · 项目内 name 必须唯一
          </p>
        </div>
        <Button variant="ghost" onClick={() => navigate(`/p/${projectId}/versions/select`)}>
          返回选择
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
        <div
          className="glass-panel"
          style={{
            padding: '12px 14px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-surface-elevated)',
            border: '1px solid var(--color-glass-panel-border)',
            marginBottom: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <Input
            placeholder="版本名（如 v1.0 / 2026Q1）"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            style={{ width: 200 }}
          />
          <Input
            placeholder="描述（可选）"
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            style={{ flex: 1 }}
          />
          <Button
            disabled={busy || !form.name.trim()}
            onClick={() => {
              setBusy(true);
              create.mutate(
                { name: form.name.trim(), description: form.description.trim() || undefined },
                { onSettled: () => setBusy(false) },
              );
            }}
          >
            新建版本
          </Button>
        </div>

        {isLoading ? (
          <div className="flex items-center" style={{ color: 'var(--color-foreground-muted)', fontSize: 13 }}>
            <Icon name="loader" size={14} className="animate-spin" />
            <span style={{ marginLeft: 6 }}>加载中...</span>
          </div>
        ) : versions.length === 0 ? (
          <div className="text-[13px]" style={{ color: 'var(--color-foreground-muted)' }}>
            暂无版本
          </div>
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
            {versions.map((v) => (
              <div
                key={v.id}
                className="glass-panel"
                style={{
                  padding: '14px 16px',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--color-surface-elevated)',
                  border: '1px solid var(--color-glass-panel-border)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-foreground)' }}>{v.name}</span>
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
                  </div>
                </div>
                {v.description && (
                  <div className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>
                    {v.description}
                  </div>
                )}
                {v.ref && v.refKind && (
                  <div className="text-[11px]" style={{ color: 'var(--color-foreground-secondary)' }}>
                    {v.refKind === 'branch' ? '⎇' : '⌖'} {v.ref}
                  </div>
                )}
                <div className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
                  用例 {v.caseCount ?? 0} · 环境 {v.environmentCount ?? 0} · 计划 {v.planCount ?? 0}
                </div>
                <div className="flex items-center gap-2" style={{ marginTop: 4, flexWrap: 'wrap' }}>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!project?.repoUrl}
                    title={project?.repoUrl ? '编辑 ref' : '请先到项目设置配置仓库'}
                    onClick={() => setRefForm({ open: true, version: v })}
                  >
                    编辑 ref
                  </Button>
                  {!v.isDefault && (
                    <Button variant="ghost" onClick={() => setDefault.mutate(v.id)}>
                      设为默认
                    </Button>
                  )}
                  <Button variant="ghost" onClick={() => remove.mutate(v.id)}>
                    删除
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <RefEditDialog
        state={refForm}
        projectId={projectId ?? ''}
        onClose={() => setRefForm({ open: false, version: null })}
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

function RefEditDialog({
  state,
  projectId,
  onClose,
  onSubmit,
  saving,
}: {
  state: { open: boolean; version: ProjectVersion | null };
  projectId: string;
  onClose: () => void;
  onSubmit: (ref: string | null, refKind: 'branch' | 'tag' | null) => void;
  saving: boolean;
}) {
  const v = state.version;
  const [refKind, setRefKind] = useState<'branch' | 'tag' | null>(v?.refKind ?? 'branch');
  const [refValue, setRefValue] = useState<string>(v?.ref ?? '');
  const [refs, setRefs] = useState<string[]>([]);
  const [refsError, setRefsError] = useState<string | null>(null);
  const [loadingRefs, setLoadingRefs] = useState(false);

  const loadRefs = async (kind: 'branch' | 'tag') => {
    if (!projectId) return;
    setLoadingRefs(true);
    setRefsError(null);
    try {
      const r = await api.versions.listRefs(projectId, kind);
      setRefs(r.refs);
      if (r.error) setRefsError(r.error);
    } catch (e) {
      setRefsError((e as Error).message);
    } finally {
      setLoadingRefs(false);
    }
  };

  return (
    <Dialog open={state.open} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>编辑版本 ref · {v?.name ?? ''}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => { setRefKind('branch'); loadRefs('branch'); }}
              className="px-3 py-1 rounded text-[12px]"
              style={{
                background: refKind === 'branch' ? 'var(--color-accent-soft)' : 'var(--color-surface-elevated)',
                color: refKind === 'branch' ? 'var(--color-accent)' : 'var(--color-foreground)',
                border: '1px solid var(--color-glass-border)',
              }}
            >
              分支 (branch)
            </button>
            <button
              type="button"
              onClick={() => { setRefKind('tag'); loadRefs('tag'); }}
              className="px-3 py-1 rounded text-[12px]"
              style={{
                background: refKind === 'tag' ? 'var(--color-accent-soft)' : 'var(--color-surface-elevated)',
                color: refKind === 'tag' ? 'var(--color-accent)' : 'var(--color-foreground)',
                border: '1px solid var(--color-glass-border)',
              }}
            >
              标签 (tag)
            </button>
          </div>
          {refKind && (
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium" style={{ color: 'var(--color-foreground-muted)' }}>
                远端 {refKind}（项目未配置仓库时不可用）
              </label>
              {loadingRefs ? (
                <span className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>加载中…</span>
              ) : refsError ? (
                <div className="flex flex-col gap-1">
                  <span className="text-[11px]" style={{ color: 'var(--color-destructive)' }}>{refsError}</span>
                  <Input placeholder="手动输入 ref 名称" value={refValue} onChange={(e) => setRefValue(e.target.value)} />
                </div>
              ) : refs.length === 0 ? (
                <div className="flex items-center gap-2">
                  <Button variant="ghost" onClick={() => loadRefs(refKind)}>重新拉取</Button>
                  <Input placeholder="手动输入 ref 名称" value={refValue} onChange={(e) => setRefValue(e.target.value)} />
                </div>
              ) : (
                <select className="input-base" value={refValue} onChange={(e) => setRefValue(e.target.value)}>
                  <option value="">— 不指定 —</option>
                  {refs.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              )}
            </div>
          )}
          <div className="flex items-center justify-between">
            <button
              type="button"
              className="text-[11px]"
              style={{ background: 'transparent', border: 'none', color: 'var(--color-foreground-muted)', cursor: 'pointer' }}
              onClick={() => { setRefKind(null); setRefValue(''); }}
            >
              清空 ref（不绑定）
            </button>
          </div>
        </div>
        <div
          className="flex justify-end gap-2 px-5 py-4 hairline-top"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button
            disabled={saving || (refKind !== null && !refValue.trim())}
            onClick={() => onSubmit(refKind ? refValue.trim() : null, refKind)}
          >
            {saving ? '保存中...' : '保存'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}