import { useUIStore } from '../../stores/ui';

const kindStyles = {
  success: {
    background: 'linear-gradient(var(--color-success-light), var(--color-success-light)), var(--color-surface-overlay)',
    color: 'var(--color-success-text)',
    border: '1px solid var(--color-success-border)',
    dot: 'var(--color-success)',
  },
  error: {
    background: 'linear-gradient(var(--color-destructive-light), var(--color-destructive-light)), var(--color-surface-overlay)',
    color: 'var(--color-destructive-text)',
    border: '1px solid var(--color-destructive-border)',
    dot: 'var(--color-destructive)',
  },
  info: {
    background: 'linear-gradient(var(--color-info-light), var(--color-info-light)), var(--color-surface-overlay)',
    color: 'var(--color-info-text)',
    border: '1px solid var(--color-info-border)',
    dot: 'var(--color-info)',
  },
} as const;

/** portal 浮层不透明：tint 叠在 --color-surface-overlay 之上（iDO toast 规范）。 */
export default function ToastRenderer() {
  const toasts = useUIStore((s) => s.toasts);
  const dismiss = useUIStore((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        alignItems: 'flex-end',
      }}
    >
      {toasts.map((t) => {
        const s = kindStyles[t.kind];
        return (
          <div
            key={t.id}
            role="status"
            onClick={() => dismiss(t.id)}
            style={{
              padding: '8px 14px 8px 12px',
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 500,
              lineHeight: 1.4,
              boxShadow: 'var(--shadow-middle)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              maxWidth: 380,
              cursor: 'pointer',
              background: s.background,
              color: s.color,
              border: s.border,
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: s.dot }} />
            {t.message}
          </div>
        );
      })}
    </div>
  );
}
