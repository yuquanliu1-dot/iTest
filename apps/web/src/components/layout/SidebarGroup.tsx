import { type IconName } from '../Icon';
import SidebarNavItem from './SidebarNavItem';

export interface NavItemDef {
  path: string;
  icon: IconName;
  label: string;
  end?: boolean;
}

export interface NavGroupDef {
  id: string;
  label: string;
  items: NavItemDef[];
}

interface SidebarGroupProps {
  group: NavGroupDef;
  collapsed: boolean;
  isFirst?: boolean;
}

export default function SidebarGroup({ group, collapsed, isFirst }: SidebarGroupProps) {
  if (collapsed) {
    // 折叠态平铺：所有可见项直接渲染为纯图标磁贴（无二级弹层），
    // 分组间 hairline 分隔（VS Code 活动栏式分段）
    return (
      <div
        style={{
          marginTop: isFirst ? 0 : 6,
          paddingTop: isFirst ? 0 : 6,
          borderTop: isFirst ? undefined : '1px solid var(--color-border-subtle)',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        {group.items.map((item) => (
          <SidebarNavItem key={item.path} icon={item.icon} label={item.label} path={item.path} end={item.end} collapsed />
        ))}
      </div>
    );
  }

  return (
    <div
      style={{
        paddingTop: isFirst ? 0 : 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
      }}
    >
      {/* 静态分组标签：纯说明文字，不可交互（Linear 式导航） */}
      <div
        className="group-nav-header"
        style={{
          height: 24,
          padding: '0 8px',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            lineHeight: '14px',
          }}
        >
          {group.label}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, paddingTop: 2 }}>
        {group.items.map((item) => (
          <SidebarNavItem
            key={item.path}
            icon={item.icon}
            label={item.label}
            path={item.path}
            end={item.end}
            collapsed={false}
          />
        ))}
      </div>
    </div>
  );
}
