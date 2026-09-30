import { type IconName } from '../Icon';
import SidebarNavItem from './SidebarNavItem';

export interface NavItemDef {
  path: string;
  icon: IconName;
  label: string;
  end?: boolean;
  /** Hidden when no project is in context. Default false. */
  projectOnly?: boolean;
}

export interface NavGroupDef {
  id: string;
  label: string;
  items: NavItemDef[];
}

interface SidebarGroupProps {
  group: NavGroupDef;
  basePath: string;
  hasProject: boolean;
  collapsed: boolean;
  isFirst?: boolean;
}

function resolvePath(basePath: string, itemPath: string): string {
  if (itemPath.startsWith('/')) return itemPath;
  const sep = basePath.endsWith('/') ? '' : '/';
  return `${basePath}${sep}${itemPath}`;
}

export default function SidebarGroup({ group, basePath, hasProject, collapsed, isFirst }: SidebarGroupProps) {
  const visibleItems = group.items.filter((it) => hasProject || !it.projectOnly);

  if (collapsed) {
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
        {visibleItems.map((item) => (
          <SidebarNavItem
            key={item.path}
            icon={item.icon}
            label={item.label}
            path={resolvePath(basePath, item.path)}
            end={item.end}
            collapsed
          />
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
        {visibleItems.map((item) => (
          <SidebarNavItem
            key={item.path}
            icon={item.icon}
            label={item.label}
            path={resolvePath(basePath, item.path)}
            end={item.end}
            collapsed={false}
          />
        ))}
      </div>
    </div>
  );
}