import type { CSSProperties, MouseEvent, KeyboardEvent } from 'react';
import Icon, { type IconName } from '../Icon';

type Tone = 'muted' | 'accent' | 'destructive';
type Size = 'sm' | 'md';

interface IconButtonProps {
  icon: IconName;
  /** Tooltip + aria-label. Falls back to the icon name. */
  title?: string;
  tone?: Tone;
  size?: Size;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
}

const toneColor: Record<Tone, string> = {
  muted: 'var(--color-foreground-muted)',
  accent: 'var(--color-accent)',
  destructive: 'var(--color-destructive)',
};

const sizeMap: Record<Size, { box: number; icon: number; padding: number }> = {
  sm: { box: 22, icon: 12, padding: 2 },
  md: { box: 28, icon: 14, padding: 4 },
};

/**
 * Tiny icon-only action: 面板内迁 / 上 / 下 / 编辑 / 删除等行内按钮的唯一规范。
 * - 始终带 .press 类（按下微缩放）和 title（hover tooltip + a11y label）。
 * - hover 时 tone 颜色提亮一档（accent → accent-hover，muted → foreground-secondary）。
 * - disabled: opacity 0.3 + cursor not-allowed。
 * - 折叠按钮如需整行可达，把 onClick 接到外层容器即可。
 */
export default function IconButton({
  icon,
  title,
  tone = 'muted',
  size = 'sm',
  disabled,
  className = '',
  style,
  onClick,
}: IconButtonProps) {
  const { box, icon: iconSize, padding } = sizeMap[size];
  const aria = title ?? icon;

  // Disabled 时 onClick 阻断，但要把 a11y 留住；用 button disabled.
  return (
    <button
      type="button"
      aria-label={aria}
      title={title ?? aria}
      disabled={disabled}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        if (disabled) return;
        onClick?.(e);
      }}
      onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
        if (disabled) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          (e.currentTarget as HTMLButtonElement).click();
        }
      }}
      className={`press ${className}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: box,
        height: box,
        padding,
        border: 'none',
        background: 'transparent',
        color: toneColor[tone],
        borderRadius: 'var(--radius-sm)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.3 : 1,
        transition: 'color 0.15s ease, background 0.15s ease',
        flexShrink: 0,
        ...style,
      }}
    >
      <Icon name={icon} size={iconSize} />
    </button>
  );
}