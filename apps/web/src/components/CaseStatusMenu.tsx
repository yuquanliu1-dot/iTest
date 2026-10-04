import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type CaseStatus } from '../api/client';
import { useUIStore } from '../stores/ui';
import { caseStatusLabel } from '../lib/format';
import StatusPill from './ui/StatusPill';

const STATUSES: CaseStatus[] = ['draft', 'review', 'ready', 'deprecated'];

/** 可点击的状态 pill：弹出单选菜单改用例状态。详情页头部与用例列表行复用。 */
export default function CaseStatusMenu({
  caseId,
  status,
  projectId,
  onChanged,
}: {
  caseId: string;
  status: string;
  /** 传入则同时 invalidate 该项目的用例列表（列表行内场景） */
  projectId?: string;
  onChanged?: (next: CaseStatus) => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const qc = useQueryClient();
  const toast = useUIStore((s) => s.showToast);

  const patch = useMutation({
    mutationFn: (next: CaseStatus) => api.cases.patch(caseId, { status: next }),
    onSuccess: (_r, next) => {
      qc.invalidateQueries({ queryKey: ['case', caseId] });
      if (projectId) qc.invalidateQueries({ queryKey: ['cases', projectId] });
      toast(`状态已改为${caseStatusLabel(next)}`, 'success');
      setOpen(false);
      onChanged?.(next);
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  useEffect(() => {
    if (!open) return;
    setAnchor(null);
    const rect = ref.current?.getBoundingClientRect();
    if (rect) setAnchor({ top: rect.bottom + 4, left: Math.max(8, rect.left) });
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <span ref={ref} className="relative inline-flex">
      <button
        type="button"
        title="点击修改状态"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
      >
        <StatusPill status={status}>{caseStatusLabel(status)}</StatusPill>
      </button>
      {open &&
        anchor &&
        createPortal(
          <div
            className="rounded-[var(--radius-sm)] overflow-hidden popover-in"
            style={{
              position: 'fixed',
              top: anchor.top,
              left: anchor.left,
              minWidth: 120,
              zIndex: 9999,
              border: '1px solid var(--border)',
              background: 'var(--card)',
              boxShadow: 'var(--shadow-2xl)',
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                disabled={patch.isPending}
                onClick={() => {
                  if (s === status) { setOpen(false); return; }
                  patch.mutate(s);
                }}
                className="w-full text-left px-3 py-1.5 text-[12px] cursor-pointer hover:bg-[var(--muted)] flex items-center justify-between gap-2"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: s === status ? 'var(--primary)' : 'var(--foreground)',
                }}
              >
                {caseStatusLabel(s)}
                {s === status && <span>✓</span>}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </span>
  );
}
