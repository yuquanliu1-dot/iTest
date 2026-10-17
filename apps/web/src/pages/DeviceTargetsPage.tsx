import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
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
      toast(t('device:saved'), 'success');
      setDraft(null);
      setEditingId(null);
      qc.invalidateQueries({ queryKey: ['deviceTargets', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const remove = useMutation({
    mutationFn: (t: DeviceTarget) => api.deviceTargets.remove(projectId!, t.id),
    onSuccess: () => {
      toast(t('device:deleted'), 'success');
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
          {t('device:back')}
        </Button>
        <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
        <h1 className="text-[16px] font-semibold">{t('device:title')}</h1>
        <div className="flex-1" />
        <Button onClick={() => { setEditingId(null); setDraft({ ...emptyDraft }); }}>
          <Icon name="plus" size={12} />
          {t('device:addTitle')}
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <Icon name="loader" size={16} className="animate-spin" />
        ) : (list?.length ?? 0) === 0 ? (
          <EmptyState icon="tablet" title={t('device:emptyTitle')} description={t('device:emptyDescription')} />
        ) : (
          <div className="flex flex-col gap-2">
            {list!.map((target) => (
              <div key={target.id} className="bg-card border rounded-[var(--radius-md)] p-4 flex items-center gap-3">
                <Icon name="tablet" size={20} />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium">{target.name}</div>
                  <div className="text-[11px] font-mono" style={{ color: 'var(--muted-foreground)' }}>
                    {target.mobileOs} · {target.deviceRef}{target.appBundleId ? ` · ${target.appBundleId}` : ''}
                  </div>
                </div>
                <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{fullDateTime(target.updatedAt)}</span>
                <IconButton icon="pencil" title={t('device:edit')} onClick={() => onEdit(target)} />
                <IconButton icon="trash" title={t('common:delete')} tone="destructive" onClick={() => setConfirmDelete(target)} />
              </div>
            ))}
          </div>
        )}
      </div>
      {draft && (
        <Dialog open onOpenChange={(o) => !o && setDraft(null)}>
          <DialogContent style={{ maxWidth: 520 }}>
            <DialogHeader><DialogTitle>{editingId ? t('device:editTitle') : t('device:addTitle')}</DialogTitle></DialogHeader>
            <div className="flex flex-col gap-3 px-5 py-4">
              <Input
                label={t('device:nameLabel')}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="iPhone 17 Pro (Sim)"
              />
              <div className="flex flex-col gap-1">
                <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('device:platform')}</span>
                <Segmented
                  value={draft.mobileOs}
                  onChange={(v) => setDraft({ ...draft, mobileOs: v as 'ios' | 'android' })}
                  options={[{ value: 'ios', label: 'iOS' }, { value: 'android', label: 'Android' }]}
                />
              </div>
              <Input
                label={t('device:deviceRefLabel')}
                value={draft.deviceRef}
                onChange={(e) => setDraft({ ...draft, deviceRef: e.target.value })}
              />
              <Input
                label={t('device:bundleIdLabel')}
                value={draft.appBundleId ?? ''}
                onChange={(e) => setDraft({ ...draft, appBundleId: e.target.value })}
                placeholder="com.example.app"
              />
              <Input
                label={t('device:appPathLabel')}
                value={draft.appPath ?? ''}
                onChange={(e) => setDraft({ ...draft, appPath: e.target.value })}
              />
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setDraft(null)}>{t('common:cancel')}</Button>
              <Button
                disabled={!draft.name.trim() || !draft.deviceRef.trim() || save.isPending}
                onClick={() => save.mutate(draft)}
              >
                {save.isPending ? t('device:saving') : t('common:save')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {confirmDelete && (
        <Dialog open onOpenChange={(o) => !o && setConfirmDelete(null)}>
          <DialogContent style={{ maxWidth: 420 }}>
            <DialogHeader><DialogTitle>{t('device:deleteTitle')}</DialogTitle></DialogHeader>
            <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
              {t('device:deleteConfirm', { name: confirmDelete.name })}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>{t('common:cancel')}</Button>
              <Button
                variant="danger"
                disabled={remove.isPending}
                onClick={() => remove.mutate(confirmDelete)}
              >
                {remove.isPending ? t('device:deleting') : t('device:confirmDelete')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
