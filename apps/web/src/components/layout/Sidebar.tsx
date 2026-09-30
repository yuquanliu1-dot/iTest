import { useEffect } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useLayoutStore } from '../../stores/layout';
import { useThemeStore } from '../../stores/theme';
import Icon from '../Icon';
import SidebarGroup, { type NavGroupDef } from './SidebarGroup';

const TEST_GROUP: NavGroupDef = {
  id: 'workspace',
  label: '工作区',
  items: [
    { path: '/', icon: 'layers', label: '项目', end: true },
    { path: '/settings', icon: 'settings', label: '设置' },
  ],
};

const NAV_GROUPS: NavGroupDef[] = [TEST_GROUP];

export default function Sidebar() {
  const sidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);

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

  return (
    <Tooltip.Provider delayDuration={300}>
      <nav
        className="glass-panel"
        style={{
          // backdrop-filter 创建独立 stacking context，抬高 nav 本体
          // （40 < dialog 1100 < toast 9999 < skip-link 60 之下不受影响）
          position: 'relative',
          zIndex: 40,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'visible',
          width: sidebarCollapsed ? 60 : 240,
          minWidth: sidebarCollapsed ? 60 : 240,
          transition: 'width 200ms ease-out, min-width 200ms ease-out',
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
          }}
        >
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              background: 'var(--color-accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <span style={{ color: 'white', fontSize: 10, fontWeight: 700, letterSpacing: 0.2 }}>iTest</span>
          </div>

          {/* Collapse/Expand toggle */}
          <button
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}
            style={{
              width: 14,
              height: 22,
              border: 'none',
              background: 'transparent',
              color: 'var(--color-foreground)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              padding: 0,
              position: sidebarCollapsed ? 'absolute' : 'static',
              right: sidebarCollapsed ? 0 : undefined,
              top: sidebarCollapsed ? 3 : undefined,
              zIndex: sidebarCollapsed ? 2 : undefined,
            }}
          >
            <Icon name={sidebarCollapsed ? 'chevronRight' : 'chevronLeft'} size={10} />
          </button>
        </div>

        {/* Navigation groups */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 1, marginTop: 6, overflowY: 'auto' }}>
          {NAV_GROUPS.map((g, i) => (
            <SidebarGroup key={g.id} group={g} collapsed={sidebarCollapsed} isFirst={i === 0} />
          ))}
        </div>

        {/* 底部工具区：主题切换 */}
        <div
          style={{
            borderTop: '1px solid var(--color-border-subtle)',
            margin: '6px 0 10px',
            padding: '6px 0 0',
          }}
        >
          {sidebarCollapsed ? (
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <button
                  onClick={toggleTheme}
                  aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
                  className="group-nav-tile w-full flex items-center justify-center"
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    height: 32,
                    borderRadius: 5,
                    color: 'var(--color-foreground-secondary)',
                  }}
                >
                  <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
                </button>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content
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
                  {theme === 'dark' ? '浅色主题' : '深色主题'}
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          ) : (
            <button
              onClick={toggleTheme}
              className="block w-full px-2 group-nav-item"
              style={{ background: 'none', border: 'none', cursor: 'pointer', width: '100%', textAlign: 'left' }}
            >
              <div
                className="flex flex-row items-center gap-[10px] w-full cursor-pointer"
                style={{ height: 36, padding: '0 8px', borderRadius: 5, color: 'var(--color-foreground-secondary)', fontSize: 13 }}
              >
                <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
                <span className="flex-1 truncate">{theme === 'dark' ? '浅色主题' : '深色主题'}</span>
              </div>
            </button>
          )}
        </div>
      </nav>
    </Tooltip.Provider>
  );
}
