import { cn } from '../../lib/cn';
import type * as React from 'react';

// CRM page-shell port: content-area padding + clamp(100%-2rem,100rem) container + page title family.
// Pages adopt it one by one in Phase 4; contained is for full-height app-style pages (no outer scrolling).
// Container width strategy: nearly edge-to-edge on small screens, capped at 1600px on large screens (≥1920),
// growing linearly in between to reduce large blank margins on wide screens.

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
          // Large-screen adaptive: clamp(available width - 2rem padding, 1600px)
          // below 1024 ≈ screen width; 1440 ≈ 1376; growth stops at 1600 once 1920 is reached to avoid over-wide layouts
          'mx-auto flex w-full min-w-0 max-w-[min(100%-2rem,100rem)] flex-1 flex-col gap-6',
          // In contained mode shrinking must be allowed, otherwise min-height:auto makes the content overflow
          // the overflow-hidden scroll container and the bottom (e.g. the paginator) gets clipped and unscrollable.
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
      // In contained mode min-h-0 + overflow-hidden keep the DataTable card from
      // overflowing PageShell and pin the paginator to the bottom of the viewport.
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
