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
  /** 未选项目时点击 projectOnly 菜单的拦截回调。 */
  onRequireProject?: () => void;
}

function resolvePath(basePath: string, itemPath: string): string {
  if (itemPath.startsWith('/')) return itemPath;
  const sep = basePath.endsWith('/') ? '' : '/';
  return `${basePath}${sep}${itemPath}`;
}

export default function SidebarGroup({ group, basePath, hasProject, collapsed, isFirst, onRequireProject }: SidebarGroupProps) {
  const renderItems = group.items.map((it) => ({
    it,
    path: resolvePath(basePath, it.path),
    needPick: Boolean(it.projectOnly && !hasProject),
  }));

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
        {renderItems.map(({ it, path, needPick }) => (
          <SidebarNavItem
            key={it.path}
            icon={it.icon}
            label={it.label}
            path={path}
            end={it.end}
            collapsed
            onClick={needPick ? onRequireProject : undefined}
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
        {renderItems.map(({ it, path, needPick }) => (
          <SidebarNavItem
            key={it.path}
            icon={it.icon}
            label={it.label}
            path={path}
            end={it.end}
            collapsed={false}
            onClick={needPick ? onRequireProject : undefined}
          />
        ))}
      </div>
    </div>
  );
}