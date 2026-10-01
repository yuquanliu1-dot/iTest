import { useNavigate } from 'react-router-dom';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useAuthStore } from '../../stores/auth';
import { useThemeStore } from '../../stores/theme';
import { useUIStore } from '../../stores/ui';
import Icon from '../Icon';
import Toggle from '../ui/Toggle';

/**
 * 侧边栏底部的用户下拉：头像 + 用户信息 + 多组织切换 + 成员管理 + 配置 + 主题 + 退出。
 * collapsed=true 时只显示头像圆点（磁贴形式）。
 */
export default function UserMenu({ collapsed = false }: { collapsed?: boolean }) {
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const user = useAuthStore((s) => s.user);
  const organizations = useAuthStore((s) => s.organizations);
  const activeOrgId = useAuthStore((s) => s.activeOrgId);
  const switchOrg = useAuthStore((s) => s.switchOrg);
  const logout = useAuthStore((s) => s.logout);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const canManageMembers = useAuthStore((s) => s.organizations.some((o) => o.isManager));

  const activeOrg = organizations.find((o) => o.id === activeOrgId);
  const showOrgList = organizations.length > 1;

  const initial = (user?.displayName || user?.username || '?').trim().charAt(0).toUpperCase();

  const handleSwitch = async (orgId: string) => {
    if (orgId === activeOrgId) return;
    try {
      await switchOrg(orgId);
      toast('已切换组织', 'success');
      navigate('/');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  // 触发器样式：折叠态仅头像磁贴，展开态整行（含名字 + 当前组织）
  const triggerStyle: React.CSSProperties = collapsed
    ? {
        width: 32,
        height: 32,
        borderRadius: '50%',
        border: '1px solid var(--color-glass-panel-border)',
        background: 'var(--color-accent-light)',
        color: 'var(--color-accent)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        fontSize: 13,
        fontWeight: 600,
        padding: 0,
      }
    : {
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 8px',
        borderRadius: 'var(--radius-sm)',
        border: 'none',
        background: 'transparent',
        color: 'var(--color-foreground)',
        cursor: 'pointer',
        textAlign: 'left',
      };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button aria-label="用户菜单" style={triggerStyle}>
          <span
            style={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              background: 'var(--color-accent-light)',
              color: 'var(--color-accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 12,
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            {initial}
          </span>
          {!collapsed && (
            <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--color-foreground)',
                  lineHeight: 1.2,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {user?.displayName || user?.username}
              </span>
              <span
                style={{
                  fontSize: 11,
                  color: 'var(--color-foreground-muted)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {activeOrg?.name ?? ''}
              </span>
            </span>
          )}
          {!collapsed && <Icon name="chevronUp" size={14} style={{ color: 'var(--color-foreground-muted)' }} />}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          side={collapsed ? 'right' : 'top'}
          sideOffset={collapsed ? 8 : 6}
          style={{
            minWidth: 260,
            background: 'var(--color-background-elevated)',
            border: '1px solid var(--color-glass-panel-border)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-elevated)',
            padding: 6,
            zIndex: 100,
          }}
        >
          {/* 用户信息区：用户名 + 当前组织 */}
          <div
            style={{
              padding: '10px 10px 12px',
              borderBottom: '1px solid var(--color-border-subtle)',
              marginBottom: 4,
            }}
          >
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--color-foreground)',
                lineHeight: 1.3,
              }}
            >
              {user?.displayName || user?.username}
            </div>
            <div
              style={{
                fontSize: 11,
                color: 'var(--color-foreground-muted)',
                marginTop: 2,
              }}
            >
              @{user?.username}
            </div>
            {activeOrg && (
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  marginTop: 8,
                  padding: '2px 8px',
                  borderRadius: 999,
                  background: 'var(--color-accent-light)',
                  color: 'var(--color-accent)',
                  fontSize: 11,
                  fontWeight: 500,
                }}
              >
                <Icon name="layers" size={11} />
                {activeOrg.name}
              </div>
            )}
          </div>

          {/* 切换组织（多组织时显示） */}
          {showOrgList && (
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger
                style={{
                  width: '100%',
                  padding: '8px 10px',
                  borderRadius: 'var(--radius-sm)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 13,
                  color: 'var(--color-foreground)',
                  cursor: 'pointer',
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                }}
              >
                <Icon name="layers" size={14} />
                <span style={{ flex: 1, textAlign: 'left' }}>切换组织</span>
                <Icon name="chevronRight" size={12} />
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent
                  sideOffset={6}
                  style={{
                    minWidth: 200,
                    background: 'var(--color-background-elevated)',
                    border: '1px solid var(--color-glass-panel-border)',
                    borderRadius: 'var(--radius-md)',
                    boxShadow: 'var(--shadow-elevated)',
                    padding: 6,
                    zIndex: 110,
                  }}
                >
                  {organizations.map((o) => (
                    <DropdownMenu.Item
                      key={o.id}
                      onSelect={(e) => {
                        e.preventDefault();
                        void handleSwitch(o.id);
                      }}
                      style={{
                        width: '100%',
                        padding: '8px 10px',
                        borderRadius: 'var(--radius-sm)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        fontSize: 13,
                        color: 'var(--color-foreground)',
                        cursor: 'pointer',
                        background: 'transparent',
                        border: 'none',
                        outline: 'none',
                      }}
                    >
                      <span style={{ flex: 1 }}>{o.name}</span>
                      {o.id === activeOrgId && <Icon name="check" size={14} />}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
          )}

          {/* 配置 */}
          <DropdownMenu.Item
            onSelect={(e) => {
              e.preventDefault();
              navigate('/settings');
            }}
            style={{
              width: '100%',
              padding: '8px 10px',
              borderRadius: 'var(--radius-sm)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 13,
              color: 'var(--color-foreground)',
              cursor: 'pointer',
              background: 'transparent',
              border: 'none',
              outline: 'none',
            }}
          >
            <Icon name="settings" size={14} />
            <span style={{ flex: 1 }}>配置</span>
          </DropdownMenu.Item>

          {/* 成员管理（任一可见组织的管理员才显示） */}
          {canManageMembers && (
            <DropdownMenu.Item
              onSelect={(e) => {
                e.preventDefault();
                navigate('/members');
              }}
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 'var(--radius-sm)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
                color: 'var(--color-foreground)',
                cursor: 'pointer',
                background: 'transparent',
                border: 'none',
                outline: 'none',
              }}
            >
              <Icon name="user" size={14} />
              <span style={{ flex: 1 }}>成员管理</span>
            </DropdownMenu.Item>
          )}

          {/* 主题切换（行内控制，不可跟随 Dropdown 关闭） */}
          <div
            style={{
              padding: '8px 10px',
              borderRadius: 'var(--radius-sm)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 13,
              color: 'var(--color-foreground)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={14} />
            <span style={{ flex: 1 }}>{theme === 'dark' ? '深色主题' : '浅色主题'}</span>
            <Toggle checked={theme === 'dark'} onChange={() => toggleTheme()} />
          </div>

          <DropdownMenu.Separator
            style={{
              height: 1,
              background: 'var(--color-border-subtle)',
              margin: '6px 4px',
            }}
          />

          {/* 退出登录 */}
          <DropdownMenu.Item
            onSelect={(e) => {
              e.preventDefault();
              void handleLogout();
            }}
            style={{
              width: '100%',
              padding: '8px 10px',
              borderRadius: 'var(--radius-sm)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 13,
              color: 'var(--color-destructive)',
              cursor: 'pointer',
              background: 'transparent',
              border: 'none',
              outline: 'none',
            }}
          >
            <Icon name="logOut" size={14} />
            <span style={{ flex: 1 }}>退出登录</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}