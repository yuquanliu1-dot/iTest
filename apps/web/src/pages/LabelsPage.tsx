import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import EmptyState from '../components/ui/EmptyState';
import Button from '../components/ui/Button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/Modal';
import LabelEditModal from '../components/labels/LabelEditModal';
import TagChip from '../components/ui/Tag';

export default function LabelsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();

  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string; color: string; description: string | null } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);

  const { data: tags, isLoading } = useQuery({
    queryKey: ['tags', projectId],
    queryFn: () => api.tags.list(projectId!),
    enabled: !!projectId,
  });

  // 统计每个 tag 用在多少 case 上 —— 复用 cases 接口做批查
  const { data: cases } = useQuery({
    queryKey: ['cases-for-tag-count', projectId],
    queryFn: () => api.cases.list({ projectId: projectId! }),
    enabled: !!projectId,
  });
  const tagCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cases ?? []) {
      for (const t of c.tags ?? []) {
        m.set(t.id, (m.get(t.id) ?? 0) + 1);
      }
    }
    return m;
  }, [cases]);

  const filtered = useMemo(() => {
    const list = tags ?? [];
    if (!search.trim()) return list;
    const q = search.trim().toLowerCase();
    return list.filter((t) => t.name.toLowerCase().includes(q));
  }, [tags, search]);

  const createMut = useMutation({
    mutationFn: (body: { name: string; color: string; description: string | null }) => api.tags.create(projectId!, body),
    onSuccess: () => {
      toast('标签已创建', 'success');
      qc.invalidateQueries({ queryKey: ['tags', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { name?: string; color?: string; description?: string | null } }) =>
      api.tags.update(projectId!, id, body),
    onSuccess: () => {
      toast('标签已更新', 'success');
      qc.invalidateQueries({ queryKey: ['tags', projectId] });
      qc.invalidateQueries({ queryKey: ['cases', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => api.tags.remove(projectId!, id),
    onSuccess: () => {
      toast('标签已删除', 'success');
      setPendingDelete(null);
      qc.invalidateQueries({ queryKey: ['tags', projectId] });
      qc.invalidateQueries({ queryKey: ['cases', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const handleEdit = (t: { id: string; name: string; color: string; description: string | null }) => {
    setEditing(t);
    setShowModal(true);
  };

  const handleCreate = () => {
    setEditing(null);
    setShowModal(true);
  };

  const handleSave = async (input: { name: string; color: string; description: string | null }) => {
    if (editing) await updateMut.mutateAsync({ id: editing.id, body: input });
    else await createMut.mutateAsync(input);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-5 pt-4 pb-3">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate(`/p/${projectId}/groups`)}
            className="flex items-center gap-1 text-[12px]"
            style={{ color: 'var(--color-foreground-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}
          >
            <Icon name="chevronLeft" size={12} />
            返回用例
          </button>
          <span style={{ width: 1, height: 16, background: 'var(--color-glass-border)' }} />
          <div>
            <h1 className="text-[22px] font-bold tracking-tight" style={{ color: 'var(--color-foreground)' }}>标签</h1>
            <p className="text-[13px] mt-0.5" style={{ color: 'var(--color-foreground-muted)' }}>项目内统一的用例分类</p>
          </div>
        </div>
        <Button onClick={handleCreate}>
          <Icon name="plus" size={12} />
          新建标签
        </Button>
      </div>

      <div className="px-5 pb-3">
        <input
          type="text"
          placeholder="搜索标签"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="input-base input-sm"
        />
      </div>

      <div
        className="flex-1 min-h-0 mx-5 mb-5 flex flex-col rounded-[12px] overflow-hidden"
        style={{ background: 'var(--color-background-elevated)', border: '1px solid var(--color-glass-border)', boxShadow: 'var(--shadow-card)' }}
      >
        {isLoading ? (
          <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)', fontSize: 13 }}>
            <Icon name="loader" size={16} className="animate-spin" />
            <span style={{ marginLeft: 8 }}>加载中...</span>
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon="tag"
            title={search ? '没有匹配的标签' : '还没有标签'}
            description={search ? '试试别的关键词' : '点击右上角「新建标签」创建一个。'}
          />
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto divide-y" style={{ borderColor: 'var(--color-muted)' }}>
            {filtered.map((t) => (
              <div key={t.id} className="flex items-center gap-3 px-5 py-3 hover:bg-[var(--color-background-subtle)]">
                <span
                  className="w-3 h-3 rounded-full shrink-0"
                  style={{ background: `#${t.color}` }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <TagChip tag={{ id: t.id, name: t.name, color: t.color }} />
                    <span className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>{tagCount.get(t.id) ?? 0} 个用例</span>
                  </div>
                  {t.description && (
                    <div className="text-[11px] mt-1" style={{ color: 'var(--color-foreground-muted)' }}>{t.description}</div>
                  )}
                </div>
                <button
                  title="编辑"
                  onClick={() => handleEdit({ id: t.id, name: t.name, color: t.color, description: t.description })}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-foreground-muted)', padding: 4 }}
                >
                  <Icon name="pencil" size={12} />
                </button>
                <button
                  title="删除"
                  onClick={() => setPendingDelete({ id: t.id, name: t.name })}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-destructive)', padding: 4 }}
                >
                  <Icon name="trash" size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <LabelEditModal
        open={showModal}
        label={editing}
        onClose={() => setShowModal(false)}
        onSave={handleSave}
      />

      <Dialog open={!!pendingDelete} onOpenChange={(v) => { if (!v) setPendingDelete(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>删除标签</DialogTitle></DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--color-foreground-secondary)' }}>
            确定删除「{pendingDelete?.name}」？该标签会从所有用例上解除，但不会删除用例。
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <Button variant="plain" onClick={() => setPendingDelete(null)}>取消</Button>
            <Button variant="danger" disabled={removeMut.isPending} onClick={() => pendingDelete && removeMut.mutate(pendingDelete.id)}>
              {removeMut.isPending ? '删除中...' : '确认删除'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
