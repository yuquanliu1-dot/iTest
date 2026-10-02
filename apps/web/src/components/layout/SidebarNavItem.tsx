import type { CSSProperties } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import * as Tooltip from '@radix-ui/react-tooltip';
import Icon, { type IconName } from '../Icon';

interface SidebarNavItemProps {
  icon: IconName;
  label: string;
  path: string;
  end?: boolean;
  count?: number;
  collapsed: boolean;
  /** 提供时替代默认的 path 导航（用于未选项目时的拦截提示）。 */
  onClick?: () => void;
}

const tooltipContentStyle: CSSProperties = {
  background: 'var(--color-foreground)',
  color: 'var(--color-surface-overlay)',
  fontSize: 11,
  padding: '4px 8px',
  borderRadius: 6,
  whiteSpace: 'nowrap',
};

function isActivePath(pathname: string, path: string, end?: boolean): boolean {
  if (end) return pathname === path;
  return pathname === path || pathname.startsWith(path + '/');
}

export default function SidebarNavItem({ icon, label, path, end, count, collapsed, onClick }: SidebarNavItemProps) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const isActive = isActivePath(pathname, path, end);
  const handleClick = onClick ?? (() => navigate(path));

  if (collapsed) {
    // 折叠态纯图标磁贴：hover 走 .group-nav-tile CSS 规则，
    // active 由 inline 样式覆盖（背景 accent-light、图标随行转 accent）
    return (
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            onClick={handleClick}
            aria-label={label}
            aria-current={isActive ? 'page' : undefined}
            className="w-full flex justify-center"
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', width: '100%' }}
          >
            <div
              className="group-nav-tile flex items-center justify-center w-full cursor-pointer press"
              style={{
                height: 32,
                borderRadius: 5,
                background: isActive ? 'var(--color-accent-light)' : undefined,
                color: isActive ? 'var(--color-accent)' : undefined,
                transition: 'background 160ms ease-out, color 160ms ease-out, transform 120ms ease',
              }}
            >
              <Icon name={icon} size={16} />
            </div>
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content side="right" className="popover-in" style={tooltipContentStyle} sideOffset={6}>
            {label}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    );
  }

  // Expanded state
  return (
    <button
      onClick={handleClick}
      className="block w-full px-2 group-nav-item"
      style={{ background: 'none', border: 'none', cursor: 'pointer', width: '100%', textAlign: 'left' }}
    >
      <div
        className="flex flex-row items-center gap-[10px] w-full cursor-pointer"
        style={{
          height: 36,
          padding: '0 8px',
          borderRadius: 5,
          // Inactive items leave background to the CSS :hover rule
          // (.group-nav-item:hover > div) so hover is not masked by inline styles.
          background: isActive ? 'var(--color-accent-light)' : undefined,
          color: isActive ? 'var(--color-accent)' : 'var(--color-foreground-secondary)',
          fontWeight: isActive ? 500 : 400,
          fontSize: 13,
          transition: 'background 160ms ease-out, color 160ms ease-out',
        }}
      >
        <Icon name={icon} size={16} />
        <span className="flex-1 truncate">{label}</span>
        {count !== undefined && count > 0 && (
          <span
            style={{
              background: isActive ? 'var(--color-accent)' : 'var(--color-surface-secondary)',
              color: isActive ? 'var(--color-accent-foreground)' : 'var(--color-foreground-muted)',
              fontSize: 10,
              lineHeight: '16px',
              padding: '0 6px',
              borderRadius: 8,
              transition: 'background 160ms ease-out, color 160ms ease-out',
            }}
          >
            {count}
          </span>
        )}
      </div>
    </button>
  );
}
