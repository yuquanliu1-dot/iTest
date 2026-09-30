/** P0-P3 → iDO priority 徽章色（urgent/high/medium/low token 组） */
const priorityStyle: Record<string, { bg: string; text: string }> = {
  P0: { bg: 'var(--color-priority-urgent-bg)', text: 'var(--color-priority-urgent-text)' },
  P1: { bg: 'var(--color-priority-high-bg)', text: 'var(--color-priority-high-text)' },
  P2: { bg: 'var(--color-priority-medium-bg)', text: 'var(--color-priority-medium-text)' },
  P3: { bg: 'var(--color-priority-low-bg)', text: 'var(--color-priority-low-text)' },
};

export default function PriorityBadge({ priority }: { priority: string }) {
  const s = priorityStyle[priority];
  if (!s) return <span style={{ color: 'var(--color-foreground-muted)', fontSize: 11 }}>{priority}</span>;
  return (
    <span
      className="inline-flex items-center rounded font-semibold uppercase tracking-wide leading-none"
      style={{ background: s.bg, color: s.text, fontSize: 9, padding: '2px 6px' }}
    >
      {priority}
    </span>
  );
}
