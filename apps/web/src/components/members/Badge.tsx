interface Props { label: string; accent?: boolean }

/** 角色/计数角标：accent 用于强调（如「管理者」），否则为中性灰。 */
export default function Badge({ label, accent }: Props) {
  return (
    <span style={{
      fontSize: 10, padding: '1px 6px', borderRadius: 999,
      border: `1px solid ${accent ? 'var(--color-accent)' : 'var(--color-glass-border)'}`,
      color: accent ? 'var(--color-accent)' : 'var(--color-foreground-muted)',
      whiteSpace: 'nowrap',
    }}>{label}</span>
  );
}
