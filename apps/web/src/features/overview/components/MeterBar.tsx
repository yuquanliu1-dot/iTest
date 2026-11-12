/**
 * Meter bar: thin rounded bar + solid semantic-color fill.
 * Track color var(--border); the fill color is a semantic var given by the caller (success/destructive/muted-foreground).
 * pct is a 0..100 number. When pct is 0 the track is transparent — zero should not be drawn as an empty gray bar;
 * the reading is given by the caller as a number.
 */
export default function MeterBar({
  pct,
  color,
  size = 'md',
}: {
  pct: number;
  color: string;
  size?: 'sm' | 'md';
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div
      className={`overflow-hidden rounded-full ${size === 'sm' ? 'h-1' : 'h-1.5'}`}
      style={{ background: clamped > 0 ? 'var(--border)' : 'transparent' }}
    >
      <div
        className="h-full rounded-full"
        style={{ width: `${clamped}%`, background: color }}
      />
    </div>
  );
}
