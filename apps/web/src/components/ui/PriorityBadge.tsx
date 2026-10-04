/** P0-P3 → iDO priority 徽章色（urgent/high/medium/low token 组） */
const priorityStyle: Record<string, { bg: string; text: string }> = {
  P0: { bg: 'var(--priority-urgent-bg)', text: 'var(--priority-urgent-text)' },
  P1: { bg: 'var(--priority-high-bg)', text: 'var(--priority-high-text)' },
  P2: { bg: 'var(--priority-medium-bg)', text: 'var(--priority-medium-text)' },
  P3: { bg: 'var(--priority-low-bg)', text: 'var(--priority-low-text)' },
};

export default function PriorityBadge({ priority }: { priority: string }) {
  const s = priorityStyle[priority];
  if (!s) return <span style={{ color: 'var(--muted-foreground)', fontSize: 11 }}>{priority}</span>;
  return (
    <span
      className="inline-flex items-center rounded font-semibold uppercase tracking-wide leading-none"
      style={{ background: s.bg, color: s.text, fontSize: 9, padding: '2px 6px' }}
    >
      {priority}
    </span>
  );
}
