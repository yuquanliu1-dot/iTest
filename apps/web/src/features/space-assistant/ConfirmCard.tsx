import { useMutation } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useUIStore } from '../../stores/ui';
import { useSpaceEventsStore, type SpaceConfirmRequest } from './spaceEventsStore';

const RISK_META: Record<SpaceConfirmRequest['risk'], { label: string; color: string; bg: string }> = {
  update: { label: '更新', color: 'var(--primary)', bg: 'var(--primary-soft)' },
  // 删除:用主题 destructive token(10% 淡出色,与 update/secret 的 10% 对齐)
  delete: { label: '删除', color: 'var(--destructive)', bg: 'var(--destructive-soft-strong)' },
  // 密钥:用主题 warning tokens(暗色模式自适配;硬编码琥珀色是 Task 2 评审否决的模式)
  secret: { label: '密钥', color: 'var(--warning)', bg: 'var(--warning-soft)' },
};

/** 确认卡:钉在 composer 上方;确认/取消 → POST /confirm,404(过期)也收卡并提示。 */
export default function ConfirmCard({ threadId }: { threadId: string }) {
  const confirms = useSpaceEventsStore((s) => s.confirms);
  const removeConfirm = useSpaceEventsStore((s) => s.removeConfirm);
  const toast = useUIStore((s) => s.showToast);
  const decide = useMutation({
    mutationFn: (v: { confirmId: string; approved: boolean }) =>
      api.assistant.confirm(threadId, v.confirmId, v.approved),
    onSuccess: (_r, v) => removeConfirm(v.confirmId),
    onError: (e: Error, v) => {
      removeConfirm(v.confirmId);
      toast(e.message, 'error');
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
                {meta.label}
              </span>
              <span className="text-[13px] font-medium truncate" style={{ color: 'var(--foreground)' }}>
                {c.summary}
              </span>
            </div>
            {c.diff && (
              <details className="mt-1.5">
                <summary className="text-[12px] cursor-pointer" style={{ color: 'var(--muted-foreground)' }}>
                  查看变更明细
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
                className="rounded-md px-2.5 py-1 text-[12px]"
                style={{ border: '1px solid var(--border)', color: 'var(--muted-foreground)', background: 'transparent' }}
                disabled={pending}
                onClick={() => decide.mutate({ confirmId: c.confirmId, approved: false })}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded-md px-2.5 py-1 text-[12px] text-white"
                style={{ background: meta.color }}
                disabled={pending}
                onClick={() => decide.mutate({ confirmId: c.confirmId, approved: true })}
              >
                {pending ? '处理中…' : '确认执行'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
