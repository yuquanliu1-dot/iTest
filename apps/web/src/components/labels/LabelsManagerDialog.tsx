import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { localizeApiError } from '../../i18n';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useUIStore } from '../../stores/ui';
import Icon from '../Icon';
import EmptyState from '../ui/EmptyState';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
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
  const { t } = useTranslation();
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

  // 统计每个 tag 用在多少 case 上 - 复用 cases 接口做批查
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
      toast(t('cases:labelDialog.created'), 'success');
      qc.invalidateQueries({ queryKey: ['tags', projectId] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { name?: string; color?: string; description?: string | null } }) =>
      api.tags.update(projectId!, id, body),
    onSuccess: () => {
      toast(t('cases:labelDialog.updated'), 'success');
      qc.invalidateQueries({ queryKey: ['tags', projectId] });
      qc.invalidateQueries({ queryKey: ['cases', projectId] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => api.tags.remove(projectId!, id),
    onSuccess: () => {
      toast(t('cases:labelDialog.deleted'), 'success');
      setPendingDelete(null);
      qc.invalidateQueries({ queryKey: ['tags', projectId] });
      qc.invalidateQueries({ queryKey: ['cases', projectId] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
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
            <DialogTitle>{t('cases:labelDialog.title')}</DialogTitle>
          </DialogHeader>
          <div
            className="flex items-center gap-2 px-5 py-3 hairline-bottom"
            style={{ borderColor: 'var(--border)' }}
          >
            <Input
              placeholder={t('cases:searchTags')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              size="sm"
              className="flex-1"
            />
            <Button size="sm" onClick={openCreate}>
              <Icon name="plus" size={12} />
              {t('cases:labelDialog.create')}
            </Button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto" style={{ maxHeight: 420 }}>
            {isLoading ? (
              <div className="flex items-center justify-center py-8" style={{ color: 'var(--muted-foreground)', fontSize: 13 }}>
                <Icon name="loader" size={16} className="animate-spin" />
                <span style={{ marginLeft: 8 }}>{t('cases:loading')}</span>
              </div>
            ) : filtered.length === 0 ? (
              <EmptyState
                icon="tag"
                title={search ? t('cases:labelDialog.emptySearchTitle') : t('cases:labelDialog.emptyTitle')}
                description={search ? t('cases:labelDialog.emptySearchDesc') : t('cases:labelDialog.emptyDesc')}
              />
            ) : (
              <div className="divide-y" style={{ borderColor: 'var(--muted)' }} data-stagger>
                {filtered.map((tag) => (
                  <div
                    key={tag.id}
                    data-stagger-item
                    className="flex items-center gap-3 px-5 py-3 hover:bg-[var(--muted)]"
                    style={{ transition: 'background 0.15s ease' }}
                  >
                    <span
                      className="w-3 h-3 rounded-full shrink-0"
                      style={{ background: `#${tag.color}`, boxShadow: `0 0 0 2px ${tag.color}22` }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <TagChip tag={{ id: tag.id, name: tag.name, color: tag.color }} />
                        <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                          {t('cases:labelDialog.caseCount', { count: tagCount.get(tag.id) ?? 0 })}
                        </span>
                      </div>
                      {tag.description && (
                        <div className="text-[11px] mt-1" style={{ color: 'var(--muted-foreground)' }}>
                          {tag.description}
                        </div>
                      )}
                    </div>
                    <IconButton
                      icon="pencil"
                      title={t('cases:edit')}
                      onClick={() => openEdit({ id: tag.id, name: tag.name, color: tag.color, description: tag.description })}
                    />
                    <IconButton
                      icon="trash"
                      title={t('common:delete')}
                      tone="destructive"
                      onClick={() => setPendingDelete({ id: tag.id, name: tag.name })}
                    />
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
          <DialogHeader><DialogTitle>{t('cases:labelDialog.deleteTitle')}</DialogTitle></DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
            {t('cases:labelDialog.deleteConfirm', { name: pendingDelete?.name ?? '' })}
          </div>
          <div
            className="flex justify-end gap-2 px-5 py-4 hairline-top"
            style={{ borderColor: 'var(--border)' }}
          >
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>{t('common:cancel')}</Button>
            <Button variant="danger" disabled={removeMut.isPending} onClick={() => pendingDelete && removeMut.mutate(pendingDelete.id)}>
              {removeMut.isPending ? t('cases:deleting') : t('cases:confirmDelete')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}