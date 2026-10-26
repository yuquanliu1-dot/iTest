import type { ReactNode } from 'react';

/**
 * 工作台作用域：跟随全局明暗主题（html.dark），自身不强制深色。
 * .workbench 重声明 --primary/--chart-1..5 为橙色系（见 index.css），两种主题都生效。
 * recharts 颜色全是 var() 字符串，随作用域自动适配，图表组件零改动。
 */
export default function WorkbenchShell({ children }: { children: ReactNode }) {
  return (
    <div className="workbench flex min-h-0 flex-1 flex-col bg-[var(--background)]">
      {children}
    </div>
  );
}
