import type { ComponentProps } from 'react';
import Icon, { type IconName } from '../Icon';
import { Button } from './shadcn/button';

type Tone = 'muted' | 'accent' | 'destructive';
type Size = 'sm' | 'md';

// Must forward native button props: Radix's <DropdownMenuTrigger asChild> merges the trigger's
// onPointerDown / aria-haspopup / data-state into the child; without them the dropdown never opens.
interface IconButtonProps extends ComponentProps<'button'> {
  icon: IconName;
  /** Tooltip + aria-label. Falls back to the icon name. */
  title?: string;
  tone?: Tone;
  size?: Size;
}

const toneClass: Record<Tone, string> = {
  muted: 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]',
  accent: 'text-[var(--primary)] hover:text-[var(--primary)] hover:bg-[var(--primary)]/10',
  destructive: 'text-[var(--destructive)] hover:text-[var(--destructive)] hover:bg-[var(--destructive)]/10',
};

// Size aligned with CRM icon tiers: sm→icon-xs (24px / 12px icon), md→icon-sm (28px / 14px icon)
const sizeMap: Record<Size, { shadcn: 'icon-xs' | 'icon-sm'; icon: number }> = {
  sm: { shadcn: 'icon-xs', icon: 12 },
  md: { shadcn: 'icon-sm', icon: 14 },
};

/**
 * Tiny icon-only action: the single canonical inline button for in-panel move / up / down / edit / delete actions.
 * Core is the CRM shadcn ghost icon button (hover bg-muted); tone only decides the text color.
 */
export default function IconButton({
  icon,
  title,
  tone = 'muted',
  size = 'sm',
  className = '',
  disabled,
  onClick,
  ...rest
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
      {...rest}
    >
      <Icon name={icon} size={sizeMap[size].icon} />
    </Button>
  );
}
