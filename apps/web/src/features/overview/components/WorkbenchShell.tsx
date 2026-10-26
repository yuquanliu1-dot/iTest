import type { ReactNode } from 'react';

/**
 * 工作台内容区外壳：铺底 + 参与 AppShell 的 flex 高度链。
 * 明暗跟随全局 html.dark 主题，语义色与产品其他页面共用同一套 token。
 */
export default function WorkbenchShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--background)]">
      {children}
    </div>
  );
}
