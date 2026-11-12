interface Props { label: string; accent?: boolean }

/** Role/count badge: accent for emphasis (e.g. "Manager"), otherwise neutral gray. */
export default function Badge({ label, accent }: Props) {
  return (
    <span style={{
      fontSize: 10, padding: '1px 6px', borderRadius: 999,
      border: `1px solid ${accent ? 'var(--primary)' : 'var(--border)'}`,
      color: accent ? 'var(--primary)' : 'var(--muted-foreground)',
      whiteSpace: 'nowrap',
    }}>{label}</span>
  );
}
