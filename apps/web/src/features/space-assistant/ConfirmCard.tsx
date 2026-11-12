import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { localizeApiError } from '../../i18n';
import { ApiError, api } from '../../api/client';
import { useUIStore } from '../../stores/ui';
import { useSpaceEventsStore, type SpaceConfirmRequest } from './spaceEventsStore';

const RISK_META: Record<SpaceConfirmRequest['risk'], { label: string; color: string; bg: string }> = {
  update: { label: 'assistant:confirm.risk.update', color: 'var(--primary)', bg: 'var(--primary-soft)' },
  // Delete: use the theme's destructive token (10% faded, aligned with update/secret's 10%)
  delete: { label: 'common:delete', color: 'var(--destructive)', bg: 'var(--destructive-soft-strong)' },
  // Secret: use the theme's warning tokens (adapts to dark mode automatically; hard-coded amber was a pattern rejected in the Task 2 review)
  secret: { label: 'assistant:confirm.risk.secret', color: 'var(--warning)', bg: 'var(--warning-soft)' },
};

/** Confirm card: pinned above the composer; confirm/cancel → POST /confirm; only 404 (truly expired) dismisses the card, other errors keep it for retry. */
export default function ConfirmCard({ threadId }: { threadId: string }) {
  const { t } = useTranslation();
  const confirms = useSpaceEventsStore((s) => s.confirms);
  const removeConfirm = useSpaceEventsStore((s) => s.removeConfirm);
  const toast = useUIStore((s) => s.showToast);
  const decide = useMutation({
    mutationFn: (v: { confirmId: string; approved: boolean }) =>
      api.assistant.confirm(threadId, v.confirmId, v.approved),
    onSuccess: (_r, v) => removeConfirm(v.confirmId),
    onError: (e: Error, v) => {
      // Only dismiss the card when the confirm has truly expired (404); transient issues like network blips keep the card for retry (a clicked confirm must not be recorded as cancelled because a pending item timed out)
      if (e instanceof ApiError && e.status === 404) removeConfirm(v.confirmId);
      toast(localizeApiError(e), 'error');
    },
  });
  if (confirms.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 pb-2">
      {confirms.map((c) => {
        const meta = RISK_META[c.risk] ?? RISK_META.update;
        const pending = decide.isPending;
        return (
          <div
            key={c.confirmId}
            className="rounded-[var(--radius-sm)] px-3 py-2.5"
            style={{ border: `1px solid ${meta.color}`, background: 'var(--popover)' }}
          >
            <div className="flex items-center gap-2 min-w-0">
              <span
                className="text-[10px] px-1.5 py-[1px] rounded font-medium shrink-0"
                style={{ color: meta.color, background: meta.bg }}
              >
                {t(meta.label)}
              </span>
              <span className="text-[13px] font-medium truncate" style={{ color: 'var(--foreground)' }}>
                {c.summary}
              </span>
            </div>
            {c.diff && (
              <details className="mt-1.5">
                <summary className="text-[12px] cursor-pointer" style={{ color: 'var(--muted-foreground)' }}>
                  {t('assistant:confirm.viewDiff')}
                </summary>
                <pre
                  className="mt-1 text-[11px] whitespace-pre-wrap max-h-40 overflow-y-auto"
                  style={{ color: 'var(--muted-foreground)' }}
                >
                  {c.diff}
                </pre>
              </details>
            )}
            <div className="flex justify-end gap-2 mt-2">
              <button
                type="button"
                className="btn-tint rounded-md px-2.5 py-1 text-[12px]"
                style={{ border: '1px solid var(--border)', color: 'var(--muted-foreground)' }}
                disabled={pending}
                onClick={() => decide.mutate({ confirmId: c.confirmId, approved: false })}
              >
                {t('common:cancel')}
              </button>
              <button
                type="button"
                className="btn-feedback rounded-md px-2.5 py-1 text-[12px] text-white disabled:opacity-50"
                style={{ background: meta.color }}
                disabled={pending}
                onClick={() => decide.mutate({ confirmId: c.confirmId, approved: true })}
              >
                {pending ? t('assistant:confirm.processing') : t('assistant:confirm.confirmExecute')}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
