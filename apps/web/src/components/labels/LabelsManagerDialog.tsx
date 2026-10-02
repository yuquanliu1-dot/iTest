import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useUIStore } from '../../stores/ui';
import Icon from '../Icon';
import EmptyState from '../ui/EmptyState';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/Modal';
import TagChip from '../ui/Tag';
import LabelEditModal from './LabelEditModal';

interface LabelsManagerDialogProps {
  open: boolean;
  projectId: string;
  onClose: () => void;
}

/** 项目内标签管理弹窗：列表 + 搜索 + 新建/编辑/删除。
 * 从 GroupsPage 标签过滤下拉里的「管理标签 →」按钮打开，取代原先的独立 /labels 页面。 */
export default function LabelsManagerDialog({ open, projectId, onClose }: LabelsManagerDialogProps) {
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();

  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string; color: string; description: string | null } | null>(null);
  const [showEdit, setShowEdit] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);

  const { data: tags, isLoading } = useQuery({
    queryKey: ['tags', projectId],
    queryFn: () => api.tags.list(projectId!),
    enabled: open && !!projectId,
  });

  // 统计每个 tag 用在多少 case 上 —— 复用 cases 接口做批查
  const { data: cases } = useQuery({
    queryKey: ['cases-for-tag-count', projectId],
    queryFn: () => api.cases.list({ projectId: projectId! }),
    enabled: open && !!projectId,
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

  const openCreate = () => {
    setEditing(null);
    setShowEdit(true);
  };
  const openEdit = (t: { id: string; name: string; color: string; description: string | null }) => {
    setEditing(t);
    setShowEdit(true);
  };
  const handleSave = async (input: { name: string; color: string; description: string | null }) => {
    if (editing) await updateMut.mutateAsync({ id: editing.id, body: input });
    else await createMut.mutateAsync(input);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
        <DialogContent className="max-w-[560px]">
          <DialogHeader>
            <DialogTitle>管理标签</DialogTitle>
          </DialogHeader>

          <div className="flex items-center gap-2 px-5 py-3 border-b" style={{ borderColor: 'var(--color-border)' }}>
            <Input
              placeholder="搜索标签"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              size="sm"
              className="flex-1"
            />
            <Button size="sm" onClick={openCreate}>
              <Icon name="plus" size={12} />
              新建标签
            </Button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto" style={{ maxHeight: 420 }}>
            {isLoading ? (
              <div className="flex items-center justify-center py-8" style={{ color: 'var(--color-foreground-muted)', fontSize: 13 }}>
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
              <div className="divide-y" style={{ borderColor: 'var(--color-muted)' }}>
                {filtered.map((t) => (
                  <div key={t.id} className="flex items-center gap-3 px-5 py-3 hover:bg-[var(--color-background-subtle)]">
                    <span className="w-3 h-3 rounded-full shrink-0" style={{ background: `#${t.color}` }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <TagChip tag={{ id: t.id, name: t.name, color: t.color }} />
                        <span className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
                          {tagCount.get(t.id) ?? 0} 个用例
                        </span>
                      </div>
                      {t.description && (
                        <div className="text-[11px] mt-1" style={{ color: 'var(--color-foreground-muted)' }}>{t.description}</div>
                      )}
                    </div>
                    <button
                      title="编辑"
                      onClick={() => openEdit({ id: t.id, name: t.name, color: t.color, description: t.description })}
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
        </DialogContent>
      </Dialog>

      <LabelEditModal
        open={showEdit}
        label={editing}
        onClose={() => setShowEdit(false)}
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
    </>
  );
}