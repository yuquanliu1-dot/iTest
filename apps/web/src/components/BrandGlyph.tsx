import type { CSSProperties } from 'react';

interface BrandGlyphProps {
  size?: number;
  /** When true (default), render a soft rotating beam ring behind the mark. Pass false for collapsed sidebar tile. */
  animated?: boolean;
  /** Variant used for the foreground stroke/fill. Defaults to on-accent (white). */
  foreground?: 'on-accent' | 'on-surface';
  className?: string;
  style?: CSSProperties;
}

/**
 * iTest brand mark — concentric arc with a beam ring + lowercase "i" dot.
 * Hand-drawn to replace the earlier "white text on violet square" placeholder.
 */
export default function BrandGlyph({
  size = 40,
  animated = true,
  foreground = 'on-accent',
  className,
  style,
}: BrandGlyphProps) {
  const stroke = foreground === 'on-accent' ? '#ffffff' : 'var(--primary)';
  const beam = foreground === 'on-accent' ? 'rgba(255,255,255,0.65)' : 'var(--primary)';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      role="img"
      aria-label="iTest"
      className={className}
      style={{ display: 'block', ...style }}
    >
      <defs>
        <linearGradient id="brand-accent" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#00915f" />
          <stop offset="60%" stopColor="#006b4f" />
          <stop offset="100%" stopColor="#025e46" />
        </linearGradient>
      </defs>
      {/* accent rounded square — drawn so glyph is self-contained on any backdrop */}
      <rect x="0" y="0" width="40" height="40" rx="10" fill="url(#brand-accent)" />
      {/* beam ring */}
      <g
        style={{
          transformOrigin: '20px 20px',
          animation: animated ? 'beam-rotate 14s linear infinite' : undefined,
        }}
      >
        <circle
          cx="20"
          cy="20"
          r="14.5"
          fill="none"
          stroke={beam}
          strokeOpacity="0.55"
          strokeWidth="1"
          strokeDasharray="3 4"
        />
      </g>
      {/* lowercase i: stem + dot, centered */}
      <circle cx="20" cy="13.5" r="2.4" fill={stroke} />
      <rect x="17.7" y="17.6" width="4.6" height="11" rx="2.2" fill={stroke} />
    </svg>
  );
}
