import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useLayoutStore } from '../../stores/layout';
import { useProjectStore } from '../../stores/project';
import { useUIStore } from '../../stores/ui';
import Icon from '../Icon';
import BrandGlyph from '../BrandGlyph';
import SidebarGroup, { type NavGroupDef } from './SidebarGroup';
import UserMenu from './UserMenu';

// 项目内的二级导航：始终显示；未选项目时点击会提示进入项目选择页。
const PROJECT_GROUP: NavGroupDef = {
  id: 'project',
  label: '项目',
  items: [
    { path: 'overview', icon: 'sparkles', label: '工作台', projectOnly: true },
    { path: 'groups', icon: 'beaker', label: '用例', projectOnly: true },
    { path: 'plans', icon: 'play', label: '执行计划', projectOnly: true },
    { path: 'reports', icon: 'flag', label: '执行历史', projectOnly: true },
  ],
};

const NAV_GROUPS: NavGroupDef[] = [PROJECT_GROUP];

export default function Sidebar() {
  const { projectId: urlProjectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const sidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);
  const current = useProjectStore((s) => s.current);
  const exit = useProjectStore((s) => s.exit);
  const toast = useUIStore((s) => s.showToast);

  // URL 优先，回退到 store；保证非项目页面（如 /settings）仍带旧上下文。
  const projectId = urlProjectId ?? current?.id;
  const basePath = projectId ? `/p/${projectId}` : '';
  const hasProject = Boolean(projectId);

  // Cmd+B / Ctrl+B shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggleSidebar]);

  const handleExitProject = () => {
    exit();
    navigate('/');
  };

  // 未选项目时点击项目内菜单：提示并回到项目选择页。
  const handleRequireProject = () => {
    toast('请先选择或创建项目', 'info');
    navigate('/');
  };

  return (
    <Tooltip.Provider delayDuration={300}>
      <nav
        className="glass-panel"
        style={{
          position: 'relative',
          zIndex: 40,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'visible',
          width: sidebarCollapsed ? 60 : 240,
          minWidth: sidebarCollapsed ? 60 : 240,
          transition: 'width 280ms cubic-bezier(0.16, 1, 0.3, 1), min-width 280ms cubic-bezier(0.16, 1, 0.3, 1)',
          borderRight: '1px solid var(--color-glass-panel-border)',
          padding: sidebarCollapsed ? '14px 0 0 7px' : '14px 12px 0',
        }}
        aria-label="主导航"
      >
        {/* Logo area */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: sidebarCollapsed ? 'center' : 'space-between',
            position: 'relative',
            paddingBottom: 14,
            gap: 8,
          }}
        >
          <div
            className="flex items-center"
            style={{
              gap: 10,
              minWidth: 0,
            }}
          >
            <BrandGlyph size={28} animated={!sidebarCollapsed} />
            {!sidebarCollapsed && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  lineHeight: 1.1,
                  minWidth: 0,
                }}
              >
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-foreground)', letterSpacing: '-0.01em' }}>
                  iTest
                </span>
                <span style={{ fontSize: 10, fontWeight: 500, color: 'var(--color-foreground-muted)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  Console
                </span>
              </div>
            )}
          </div>

          <button
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}
            className="press"
            style={{
              width: 22,
              height: 22,
              border: 'none',
              background: 'transparent',
              color: 'var(--color-foreground-muted)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              padding: 0,
              borderRadius: 5,
              position: sidebarCollapsed ? 'absolute' : 'static',
              right: sidebarCollapsed ? 0 : undefined,
              top: sidebarCollapsed ? 3 : undefined,
              zIndex: sidebarCollapsed ? 2 : undefined,
            }}
          >
            <Icon name={sidebarCollapsed ? 'chevronRight' : 'chevronLeft'} size={12} />
          </button>
        </div>

        {/* Navigation groups */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 1, marginTop: 6, overflowY: 'auto' }}>
          {NAV_GROUPS.map((g, i) => (
            <SidebarGroup
              key={g.id}
              group={g}
              basePath={basePath}
              hasProject={hasProject}
              collapsed={sidebarCollapsed}
              isFirst={i === 0}
              onRequireProject={handleRequireProject}
            />
          ))}
        </div>

        {/* 退出项目（用户菜单上方；折叠为磁贴，展开为整行） */}
        {hasProject &&
          (sidebarCollapsed ? (
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <button
                  onClick={handleExitProject}
                  aria-label={`退出项目：${current?.name ?? ''}`}
                  className="group-nav-tile w-full flex items-center justify-center"
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    height: 32,
                    borderRadius: 5,
                    color: 'var(--color-foreground-secondary)',
                    marginBottom: 4,
                  }}
                >
                  <Icon name="logOut" size={16} />
                </button>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content
                  className="popover-in"
                  side="right"
                  sideOffset={6}
                  style={{
                    background: 'var(--color-foreground)',
                    color: 'var(--color-background-elevated)',
                    fontSize: 11,
                    padding: '4px 8px',
                    borderRadius: 6,
                    whiteSpace: 'nowrap',
                    zIndex: 70,
                  }}
                >
                  退出项目{current?.name ? `：${current.name}` : ''}
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          ) : (
            <div style={{ marginBottom: 4 }}>
              <button
                onClick={handleExitProject}
                className="block w-full px-2 group-nav-item"
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', width: '100%', textAlign: 'left' }}
                aria-label={`退出项目：${current?.name ?? ''}`}
              >
                <div
                  className="flex items-center gap-[10px] w-full cursor-pointer"
                  style={{
                    height: 36,
                    padding: '0 8px',
                    borderRadius: 5,
                    color: 'var(--color-foreground-secondary)',
                    fontSize: 13,
                  }}
                >
                  <div className="flex items-center justify-center" style={{ width: 16, flexShrink: 0 }}>
                    <Icon name="logOut" size={16} />
                  </div>
                  <span className="flex-1 truncate">退出项目{current?.name ? `：${current.name}` : ''}</span>
                </div>
              </button>
            </div>
          ))}

        {/* 用户菜单（展开态显示完整布局，折叠态仅显示头像） */}
        <div
          style={{
            marginTop: hasProject ? 0 : 'auto',
            paddingTop: 4,
            borderTop: hasProject ? '1px solid var(--color-border-subtle)' : 'none',
            display: 'flex',
            flexDirection: 'column',
            alignItems: sidebarCollapsed ? 'center' : 'stretch',
            gap: 4,
          }}
        >
          <UserMenu collapsed={sidebarCollapsed} />
        </div>
      </nav>
    </Tooltip.Provider>
  );
}