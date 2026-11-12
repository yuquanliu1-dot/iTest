import type { ReactNode } from 'react';

/**
 * Workbench content-area shell: the base layer + participates in AppShell's flex height chain.
 * Light/dark follows the global html.dark theme; semantic colors share the same token set as the rest of the product.
 */
export default function WorkbenchShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--background)]">
      {children}
    </div>
  );
}
