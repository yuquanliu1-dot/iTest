import type { ComponentProps } from 'react';
import Icon, { type IconName } from '../Icon';
import { Button } from './shadcn/button';

type Tone = 'muted' | 'accent' | 'destructive';
type Size = 'sm' | 'md';

// 必须透传原生 button 属性：Radix 的 <DropdownMenuTrigger asChild> 会把触发器的
// onPointerDown / aria-haspopup / data-state 合并进子组件，丢了这些下拉菜单就永远打不开。
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
