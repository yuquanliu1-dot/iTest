import { cn } from '../../lib/cn';
import type * as React from 'react';

// CRM page-shell 移植：内容区 padding + clamp(100%-2rem,100rem) 容器 + 页标题族。
// 各页面在 Phase 4 逐页接入；contained 用于全高应用型页面（不外滚）。
// 容器宽度策略:小屏几乎贴边,大屏(≥1920)封顶 1600px,中间线性增长,
// 减少宽屏左右大块留白。

function PageShell({
  className,
  contained = false,
  ...props
}: React.ComponentProps<'div'> & { contained?: boolean }) {
  return (
    <div
      data-slot="page-shell-scroll"
      className={cn(
        'flex min-w-0 flex-1 flex-col px-4 pt-4 pb-4 md:px-6 md:pt-6 md:pb-6',
        contained ? 'min-h-0 overflow-hidden' : 'overflow-y-auto',
      )}
    >
      <div
        data-slot="page-shell"
        className={cn(
          // 大屏自适应:clamp(可用宽度-2rem padding, 1600px)
          // 1024 以下 ≈ 屏宽;1440 ≈ 1376;1920 拉满 1600 后停止增长,避免过宽
          'mx-auto flex w-full min-w-0 max-w-[min(100%-2rem,100rem)] flex-1 flex-col gap-6',
          // contained 模式下必须允许收缩，否则 min-height:auto 使内容撑破
          // overflow-hidden 的滚动容器，底部（如分页器）被裁掉且无法滚动。
          contained && 'min-h-0',
          className,
        )}
        {...props}
      />
    </div>
  );
}

function PageShellHeader({ className, children, ...props }: React.ComponentProps<'div'>) {
  return (
    <header
      data-slot="page-shell-header"
      className={cn('flex flex-col gap-3', className)}
      {...props}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2">
        {children}
      </div>
    </header>
  );
}

function PageShellTitle({ className, ...props }: React.ComponentProps<'h1'>) {
  return (
    <h1
      data-slot="page-shell-title"
      className={cn(
        'col-start-1 row-start-1 min-w-0 self-center text-2xl font-medium tracking-tight md:text-3xl',
        className,
      )}
      {...props}
    />
  );
}

function PageShellDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="page-shell-description"
      className={cn(
        'col-span-full row-start-2 text-sm text-[var(--muted-foreground)]',
        className,
      )}
      {...props}
    />
  );
}

function PageShellActions({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="page-shell-actions"
      className={cn(
        'col-start-2 row-start-1 flex flex-wrap items-center gap-2 self-center justify-self-end',
        className,
      )}
      {...props}
    />
  );
}

function PageShellContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="page-shell-content"
      // contained 模式下需要 min-h-0 + overflow-hidden 让 DataTable 的卡片
      // 不撑破 PageShell，并把分页器钉在视口底部。
      className={cn('flex flex-1 flex-col gap-6 min-h-0', className)}
      {...props}
    />
  );
}

export {
  PageShell,
  PageShellActions,
  PageShellContent,
  PageShellDescription,
  PageShellHeader,
  PageShellTitle,
};
