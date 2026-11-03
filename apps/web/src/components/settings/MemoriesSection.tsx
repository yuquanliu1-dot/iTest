import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { localizeApiError } from '../../i18n';
import { api, type AssistantMemory } from '../../api/client';
import { useUIStore } from '../../stores/ui';
import Icon from '../Icon';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import EmptyState from '../ui/EmptyState';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/Modal';

/** 设置页「助手记忆」：只读列表 + 软删（写入唯一入口是助手的 save_memory 工具）。 */
export default function MemoriesSection() {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  // 默认只看 active：软删/退役即从界面消失（与注入、工具读路径同口径）；审计走 API status 参数。
  const listQ = useQuery({ queryKey: ['assistant-memories'], queryFn: () => api.assistant.memories.list({ status: 'active' }) });
  const [lineFilter, setLineFilter] = useState('all');
  const [detailing, setDetailing] = useState<AssistantMemory | null>(null);
  const [deleting, setDeleting] = useState<AssistantMemory | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => api.assistant.memories.remove(id),
    onSuccess: () => {
      toast(t('settings:saved'), 'success');
      setDeleting(null);
      qc.invalidateQueries({ queryKey: ['assistant-memories'] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const rows = listQ.data ?? [];
  const lineOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (r.scope === 'product_line' && r.productLineId) m.set(r.productLineId, r.productLineName ?? r.productLineId);
    return Array.from(m.entries());
  }, [rows]);
  // 筛选的线被删空后 lineId 失配——钳回 all，避免 select 悬空+假「暂无记忆」。
  const effectiveFilter = lineFilter !== 'all' && lineFilter !== 'global' && !lineOptions.some(([id]) => id === lineFilter)
    ? 'all'
    : lineFilter;
  const filtered = effectiveFilter === 'all'
    ? rows
    : effectiveFilter === 'global'
      ? rows.filter((r) => r.scope === 'global')
      : rows.filter((r) => r.productLineId === effectiveFilter);

  return (
    <div className="bg-card border rounded-[var(--radius-sm)]">
      <div className="flex items-center gap-2 px-4 py-3 hairline-bottom" style={{ borderColor: 'var(--border)' }}>
        <Icon name="bookOpen" size={14} style={{ color: 'var(--primary)' }} />
        <h3 className="text-[14px] font-semibold m-0 flex-1" style={{ color: 'var(--foreground)' }}>
          {t('settings:memoryTitle')}
        </h3>
        <select
          className="input-base"
          style={{ width: 'auto', fontSize: 12 }}
          aria-label={t('settings:memoryFilterAll')}
          value={effectiveFilter}
          onChange={(e) => setLineFilter(e.target.value)}
        >
          <option value="all">{t('settings:memoryFilterAll')}</option>
          <option value="global">{t('settings:memoryScopeGlobal')}</option>
          {lineOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </div>
      <div className="px-4 pt-2 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
        {t('settings:memoryIntro')}
      </div>
      <div className="p-2">
        {listQ.isLoading ? (
          <div className="flex items-center gap-2 px-2 py-4 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
            <Icon name="loader" size={14} className="animate-spin" />
            {t('common:loading')}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState icon="bookOpen" title={t('settings:memoryNone')} compact />
        ) : (
          filtered.map((m) => (
            <div key={m.id} className="flex items-center gap-3 px-2 py-2">
              <div
                className="flex flex-col min-w-0 flex-1 cursor-pointer text-left"
                onClick={() => setDetailing(m)}
                title={t('settings:memoryDetailTitle')}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-medium truncate" style={{ color: 'var(--foreground)' }}>{m.title}</span>
                  <span className="text-[10px] px-1.5 py-[1px] rounded shrink-0" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}>
                    {m.scope === 'global' ? t('settings:memoryScopeGlobal') : (m.productLineName ?? '—')}
                  </span>
                  <span className="text-[10px] px-1.5 py-[1px] rounded shrink-0" style={{ background: 'var(--muted)', color: 'var(--foreground)' }}>
                    {m.provenance === 'user_stated' ? t('settings:memoryProvenanceUser') : t('settings:memoryProvenanceAi')}
                  </span>
                </div>
                <span className="text-[11px] truncate" style={{ color: 'var(--muted-foreground)' }}>{m.hook}</span>
              </div>
              <span className="text-[11px] shrink-0" style={{ color: 'var(--muted-foreground)' }}>
                {t('settings:memoryHits', { count: m.hitCount })}
              </span>
              <IconButton icon="eye" title={t('settings:memoryDetailTitle')} onClick={() => setDetailing(m)} />
              <IconButton icon="trash" tone="destructive" title={t('common:delete')} onClick={() => setDeleting(m)} />
            </div>
          ))
        )}
      </div>

      <Dialog open={!!detailing} onOpenChange={(open) => { if (!open) setDetailing(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings:memoryDetailTitle')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[13px] font-semibold" style={{ color: 'var(--foreground)' }}>{detailing?.title}</span>
              <span className="text-[10px] px-1.5 py-[1px] rounded shrink-0" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}>
                {detailing?.scope === 'global' ? t('settings:memoryScopeGlobal') : (detailing?.productLineName ?? '—')}
              </span>
              <span className="text-[10px] px-1.5 py-[1px] rounded shrink-0" style={{ background: 'var(--muted)', color: 'var(--foreground)' }}>
                {detailing?.provenance === 'user_stated' ? t('settings:memoryProvenanceUser') : t('settings:memoryProvenanceAi')}
              </span>
            </div>
            <div className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              {t('settings:memoryHits', { count: detailing?.hitCount ?? 0 })}
              {' · '}
              {detailing?.updatedAt ? new Date(detailing.updatedAt).toLocaleString() : ''}
            </div>
            <div className="min-w-0">
              <div className="text-[11px] font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>
                {t('settings:memoryHook')}
              </div>
              <div className="text-[12px] break-words" style={{ color: 'var(--foreground)' }}>{detailing?.hook}</div>
            </div>
            {detailing?.body ? (
              <div className="min-w-0">
                <div className="text-[11px] font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>
                  {t('settings:memoryBody')}
                </div>
                <div
                  className="text-[12px] whitespace-pre-wrap break-words max-h-[50vh] overflow-auto rounded border p-3"
                  style={{ borderColor: 'var(--border)', color: 'var(--foreground)' }}
                >
                  {detailing.body}
                </div>
              </div>
            ) : null}
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 hairline-top" style={{ borderColor: 'var(--border)' }}>
            <Button variant="ghost" onClick={() => setDetailing(null)}>{t('common:close')}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleting} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings:memoryDeleteConfirm', { name: deleting?.title })}</DialogTitle>
          </DialogHeader>
          <div className="flex justify-end gap-2 px-5 py-4">
            <Button variant="ghost" onClick={() => setDeleting(null)}>{t('common:cancel')}</Button>
            <Button variant="danger" disabled={remove.isPending} onClick={() => deleting && remove.mutate(deleting.id)}>
              {t('common:delete')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
