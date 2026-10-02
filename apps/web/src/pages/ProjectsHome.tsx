import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useProjectStore } from '../stores/project';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import EmptyState from '../components/ui/EmptyState';
import IconButton from '../components/ui/IconButton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/Modal';
import Input from '../components/ui/Input';
import Button from '../components/ui/Button';

interface FormState {
  open: boolean;
  mode: 'create' | 'edit';
  id: string | null;
  name: string;
  description: string;
  defaultUrl: string;
}

const EMPTY_FORM: FormState = { open: false, mode: 'create', id: null, name: '', description: '', defaultUrl: '' };

export default function ProjectsHome() {
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const enter = useProjectStore((s) => s.enter);
  const { data, isLoading } = useQuery({ queryKey: ['projects'], queryFn: api.projects.list });
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const body = { name: form.name, description: form.description || undefined, defaultUrl: form.defaultUrl || undefined };
      if (form.mode === 'create') return api.projects.create(body);
      return api.projects.patch(form.id!, body);
    },
    onSuccess: () => {
      toast(form.mode === 'create' ? '项目已创建' : '项目已更新', 'success');
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
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (e: Error) => {
      toast(e.message.includes('409') || e.message.includes('cases') ? '项目内仍有用例，请先清空再删除' : e.message, 'error');
      setConfirmDelete(null);
    },
  });

  const openProject = (p: { id: string; name: string; defaultUrl: string | null }) => {
    enter({ id: p.id, name: p.name, defaultUrl: p.defaultUrl });
    navigate(`/p/${p.id}/overview`);
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
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
        {isLoading ? (
          <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)', fontSize: 13 }}>
            <Icon name="loader" size={16} className="animate-spin" />
            <span style={{ marginLeft: 8 }}>加载中...</span>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
            {(data ?? []).map((p) => (
              <div
                key={p.id}
                className="glass-panel rounded-[12px] p-5 cursor-pointer hover-card flex flex-col"
                style={{ minHeight: 132 }}
                onClick={() => openProject(p)}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[15px] font-semibold truncate" style={{ color: 'var(--color-foreground)' }}>
                    {p.name}
                  </span>
                  <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    <IconButton
                      icon="pencil"
                      title="编辑"
                      onClick={() => setForm({ open: true, mode: 'edit', id: p.id, name: p.name, description: p.description ?? '', defaultUrl: p.defaultUrl ?? '' })}
                    />
                    <IconButton
                      icon="trash"
                      title="删除"
                      tone="destructive"
                      onClick={() => setConfirmDelete({ id: p.id, name: p.name })}
                    />
                  </div>
                </div>
                {p.description && (
                  <div className="text-[12px] mt-1 truncate" style={{ color: 'var(--color-foreground-secondary)' }}>
                    {p.description}
                  </div>
                )}
                <div className="text-[12px] mt-1 truncate" style={{ color: 'var(--color-foreground-muted)' }}>
                  {p.defaultUrl ?? '未设置默认域名'}
                </div>
                <div className="flex-1" />
                <div className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--color-foreground-secondary)' }}>
                  <Icon name="beaker" size={13} />
                  {p.caseCount} 条用例
                  <span className="flex-1" />
                  <span style={{ color: 'var(--color-accent)' }}>进入 →</span>
                </div>
              </div>
            ))}

            {/* 新建项目卡片 */}
            <button
              onClick={() => setForm({ open: true, mode: 'create', id: null, name: '', description: '', defaultUrl: '' })}
              className="rounded-[12px] p-5 flex flex-col items-center justify-center gap-2"
              style={{
                minHeight: 132,
                border: '1px dashed var(--color-glass-border)',
                background: 'transparent',
                color: 'var(--color-foreground-muted)',
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              <Icon name="plus" size={20} />
              新建项目
            </button>

            {(data ?? []).length === 0 && (
              <div className="col-span-full">
                <EmptyState icon="layers" title="还没有项目" description="创建第一个项目，开始组织测试资产。" />
              </div>
            )}
          </div>
        )}
      </div>

      {/* 新建/编辑弹窗 */}
      <Dialog open={form.open} onOpenChange={(open) => setForm((f) => ({ ...f, open }))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{form.mode === 'create' ? '新建项目' : '编辑项目'}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <Input label="名称" placeholder="如：CueCast 官网" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-foreground-secondary)' }}>描述（可空）</label>
              <textarea
                className="input-base"
                placeholder="简要说明项目用途"
                rows={3}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
            <Input
              label="默认域名（可空）"
              placeholder="https://example.com"
              value={form.defaultUrl}
              onChange={(e) => setForm((f) => ({ ...f, defaultUrl: e.target.value }))}
            />
            <p className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
              默认域名用于预填新建用例与录制的目标 URL；分组和用例可覆盖。
            </p>
          </div>
          <div
            className="flex justify-end gap-2 px-5 py-4 hairline-top"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <Button variant="plain" onClick={() => setForm(EMPTY_FORM)}>取消</Button>
            <Button disabled={!form.name.trim() || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? '保存中...' : '保存'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <Dialog open={!!confirmDelete} onOpenChange={(open) => { if (!open) setConfirmDelete(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除项目</DialogTitle>
          </DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--color-foreground-secondary)' }}>
            确定删除「{confirmDelete?.name}」？项目内存在用例时将被拒绝删除。
          </div>
          <div
            className="flex justify-end gap-2 px-5 py-4 hairline-top"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <Button variant="plain" onClick={() => setConfirmDelete(null)}>取消</Button>
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
    </div>
  );
}
