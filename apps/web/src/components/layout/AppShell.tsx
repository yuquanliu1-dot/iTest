import type { ReactNode } from 'react';
import Sidebar from './Sidebar';
import ToastRenderer from './ToastRenderer';

export default function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-dvh overflow-hidden" style={{ background: 'transparent' }}>
      {/* Keyboard-only skip link — 第一个可聚焦元素，越过侧边栏直达主内容 */}
      <a
        href="#main-content"
        className="absolute left-2 top-2 z-[60] px-3 py-1.5 rounded-[var(--radius-sm)] text-[12px] font-semibold bg-[var(--color-accent)] text-[var(--color-accent-foreground)] shadow-[var(--shadow-elevated)] -translate-y-12 focus:translate-y-0 transition-transform duration-150 outline-none"
      >
        跳到主内容
      </a>
      <Sidebar />
      <main id="main-content" className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {children}
      </main>
      <ToastRenderer />
    </div>
  );
}
