/**
 * 进度条：与主体进度条同款（细圆角条 + 语义色实心填充）。
 * 轨道色 var(--border)，填充色由调用方给语义 var（success/destructive/chart-*）。
 * pct 为 0..100 的数值。
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
      style={{ background: 'var(--border)' }}
    >
      <div
        className="h-full rounded-full"
        style={{ width: `${clamped}%`, background: color }}
      />
    </div>
  );
}
