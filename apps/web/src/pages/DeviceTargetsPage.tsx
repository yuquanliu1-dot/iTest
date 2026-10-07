import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type DeviceTarget } from '../api/client';
import Icon from '../components/Icon';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Segmented from '../components/ui/Segmented';
import EmptyState from '../components/ui/EmptyState';
import IconButton from '../components/ui/IconButton';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/Modal';
import { useUIStore } from '../stores/ui';
import { fullDateTime } from '../lib/format';

type Draft = Omit<DeviceTarget, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>;

const emptyDraft: Draft = {
  name: '',
  mobileOs: 'ios',
  deviceRef: '',
  appBundleId: '',
  appPath: '',
  launchArgs: [],
};

export default function DeviceTargetsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const { data: list, isLoading } = useQuery({
    queryKey: ['deviceTargets', projectId],
    queryFn: () => api.deviceTargets.list(projectId!),
    enabled: !!projectId,
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<DeviceTarget | null>(null);

  const save = useMutation({
    mutationFn: async (d: Draft) => {
      const body = {
        name: d.name.trim(),
        mobileOs: d.mobileOs,
        deviceRef: d.deviceRef.trim(),
        appBundleId: d.appBundleId?.trim() || null,
        appPath: d.appPath?.trim() || null,
        launchArgs: d.launchArgs,
      };
      return editingId
        ? api.deviceTargets.update(projectId!, editingId, body)
        : api.deviceTargets.create(projectId!, body);
    },
    onSuccess: () => {
      toast('已保存', 'success');
      setDraft(null);
      setEditingId(null);
      qc.invalidateQueries({ queryKey: ['deviceTargets', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const remove = useMutation({
    mutationFn: (t: DeviceTarget) => api.deviceTargets.remove(projectId!, t.id),
    onSuccess: () => {
      toast('已删除', 'success');
      setConfirmDelete(null);
      qc.invalidateQueries({ queryKey: ['deviceTargets', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const onEdit = (t: DeviceTarget) => {
    setEditingId(t.id);
    setDraft({
      name: t.name,
      mobileOs: t.mobileOs,
      deviceRef: t.deviceRef,
      appBundleId: t.appBundleId ?? '',
      appPath: t.appPath ?? '',
      launchArgs: t.launchArgs ?? [],
    });
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 px-6 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <Button variant="ghost" size="sm" onClick={() => navigate('/')}>
          <Icon name="chevronLeft" size={12} />
          返回
        </Button>
        <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
        <h1 className="text-[16px] font-semibold">设备目标</h1>
        <div className="flex-1" />
        <Button onClick={() => { setEditingId(null); setDraft({ ...emptyDraft }); }}>
          <Icon name="plus" size={12} />
          新增设备目标
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <Icon name="loader" size={16} className="animate-spin" />
        ) : (list?.length ?? 0) === 0 ? (
          <EmptyState icon="tablet" title="暂无设备目标" description="为移动端用例指定 iOS Simulator / Android Emulator 设备。" />
        ) : (
          <div className="flex flex-col gap-2">
            {list!.map((t) => (
              <div key={t.id} className="bg-card border rounded-[var(--radius-md)] p-4 flex items-center gap-3">
                <Icon name="tablet" size={20} />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium">{t.name}</div>
                  <div className="text-[11px] font-mono" style={{ color: 'var(--muted-foreground)' }}>
                    {t.mobileOs} · {t.deviceRef}{t.appBundleId ? ` · ${t.appBundleId}` : ''}
                  </div>
                </div>
                <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{fullDateTime(t.updatedAt)}</span>
                <IconButton icon="pencil" title="编辑" onClick={() => onEdit(t)} />
                <IconButton icon="trash" title="删除" tone="destructive" onClick={() => setConfirmDelete(t)} />
              </div>
            ))}
          </div>
        )}
      </div>
      {draft && (
        <Dialog open onOpenChange={(o) => !o && setDraft(null)}>
          <DialogContent style={{ maxWidth: 520 }}>
            <DialogHeader><DialogTitle>{editingId ? '编辑设备目标' : '新增设备目标'}</DialogTitle></DialogHeader>
            <div className="flex flex-col gap-3 px-5 py-4">
              <Input
                label="名称"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="iPhone 17 Pro (Sim)"
              />
              <div className="flex flex-col gap-1">
                <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>平台</span>
                <Segmented
                  value={draft.mobileOs}
                  onChange={(v) => setDraft({ ...draft, mobileOs: v as 'ios' | 'android' })}
                  options={[{ value: 'ios', label: 'iOS' }, { value: 'android', label: 'Android' }]}
                />
              </div>
              <Input
                label="设备标识（simulator name / Android emulator 名）"
                value={draft.deviceRef}
                onChange={(e) => setDraft({ ...draft, deviceRef: e.target.value })}
              />
              <Input
                label="默认 bundleId（可选）"
                value={draft.appBundleId ?? ''}
                onChange={(e) => setDraft({ ...draft, appBundleId: e.target.value })}
                placeholder="com.example.app"
              />
              <Input
                label="默认 .app / .apk 路径（可选）"
                value={draft.appPath ?? ''}
                onChange={(e) => setDraft({ ...draft, appPath: e.target.value })}
              />
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setDraft(null)}>取消</Button>
              <Button
                disabled={!draft.name.trim() || !draft.deviceRef.trim() || save.isPending}
                onClick={() => save.mutate(draft)}
              >
                {save.isPending ? '保存中...' : '保存'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {confirmDelete && (
        <Dialog open onOpenChange={(o) => !o && setConfirmDelete(null)}>
          <DialogContent style={{ maxWidth: 420 }}>
            <DialogHeader><DialogTitle>删除设备目标</DialogTitle></DialogHeader>
            <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
              确认删除「{confirmDelete.name}」？绑定的 mobile 用例将自动解绑（mobileDeviceTargetId 置 null）。
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>取消</Button>
              <Button
                variant="danger"
                disabled={remove.isPending}
                onClick={() => remove.mutate(confirmDelete)}
              >
                {remove.isPending ? '删除中...' : '确认删除'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
