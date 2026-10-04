import type { CSSProperties, MouseEvent } from 'react';
import Icon, { type IconName } from '../Icon';
import { Button } from './shadcn/button';

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

const toneClass: Record<Tone, string> = {
  muted: 'text-[var(--muted-foreground)]',
  accent: 'text-[var(--primary)] hover:text-[var(--primary)]',
  destructive: 'text-[var(--destructive)] hover:text-[var(--destructive)]',
};

// 尺寸对齐 CRM icon 档：sm→icon-xs(24px/12px 图标)、md→icon-sm(28px/14px 图标)
const sizeMap: Record<Size, { shadcn: 'icon-xs' | 'icon-sm'; icon: number }> = {
  sm: { shadcn: 'icon-xs', icon: 12 },
  md: { shadcn: 'icon-sm', icon: 14 },
};

/**
 * Tiny icon-only action: 面板内迁 / 上 / 下 / 编辑 / 删除等行内按钮的唯一规范。
 * 内核为 CRM shadcn ghost icon button（hover bg-muted），tone 只决定文字色。
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
  const aria = title ?? icon;
  return (
    <Button
      type="button"
      variant="ghost"
      size={sizeMap[size].shadcn}
      aria-label={aria}
      title={title ?? aria}
      disabled={disabled}
      onClick={onClick}
      className={`${toneClass[tone]} ${className}`}
      style={style}
    >
      <Icon name={icon} size={sizeMap[size].icon} />
    </Button>
  );
}
