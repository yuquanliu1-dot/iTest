import type { ReactNode } from 'react';
import AppHeader from './AppHeader';
import AppIconRail from './AppIconRail';
import { TooltipProvider } from '../ui/shadcn/tooltip';

export default function AppShell({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-dvh flex-col overflow-hidden bg-[var(--background)]">
        {/* Keyboard-only skip link — 第一个可聚焦元素，越过导航直达主内容 */}
        <a
          href="#main-content"
          className="absolute left-2 top-2 z-[60] -translate-y-12 rounded-[var(--radius-sm)] px-3 py-1.5 text-[12px] font-semibold text-[var(--primary-foreground)] shadow-[var(--shadow-2xl)] outline-none transition-transform duration-150 focus:translate-y-0"
          style={{ background: 'var(--primary)' }}
        >
          跳到主内容
        </a>
        <AppHeader />
        <div className="flex min-h-0 flex-1">
          <AppIconRail />
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <main id="main-content" className="flex min-w-0 flex-1 flex-col overflow-hidden">
              {children}
            </main>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
