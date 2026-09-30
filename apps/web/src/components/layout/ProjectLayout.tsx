import type { ReactNode } from 'react';
import { NavLink, Navigate, Outlet, useNavigate, useParams } from 'react-router-dom';
import Icon, { type IconName } from '../Icon';
import { useProjectStore } from '../../stores/project';

const NAV_ITEMS = [
  { path: 'overview', icon: 'sparkles', label: '工作台' },
  { path: 'groups', icon: 'beaker', label: '用例' },
  { path: 'requirements', icon: 'listChecks', label: '需求' },
  { path: 'plans', icon: 'play', label: '执行计划' },
  { path: 'reports', icon: 'flag', label: '报告' },
] as const;

function NavRow({ to, icon, label }: { to: string; icon: IconName; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) => `group-nav-item block ${isActive ? 'nav-active' : ''}`}
      style={{ textDecoration: 'none' }}
    >
      {({ isActive }) => (
        <div
          className="flex items-center gap-2 w-full"
          style={{
            height: 36,
            padding: '0 8px',
            borderRadius: 5,
            background: isActive ? 'var(--color-accent-light)' : undefined,
            color: isActive ? 'var(--color-accent)' : 'var(--color-foreground-secondary)',
            fontWeight: isActive ? 500 : 400,
            fontSize: 13,
          }}
        >
          <Icon name={icon} size={14} />
          <span className="flex-1 truncate">{label}</span>
        </div>
      )}
    </NavLink>
  );
}

/** 项目内布局：守卫（store 与 URL 不一致回首页）+ 顶部栏 + 左侧二级导航。 */
export default function ProjectLayout({ children }: { children?: ReactNode }) {
  const { projectId } = useParams<{ projectId: string }>();
  const current = useProjectStore((s) => s.current);
  const exit = useProjectStore((s) => s.exit);
  const navigate = useNavigate();

  if (!current || current.id !== projectId) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 顶部栏：项目名 + 退出项目 */}
      <div
        className="flex items-center gap-3 px-5 py-2.5 shrink-0"
        style={{ borderBottom: '1px solid var(--color-glass-border)' }}
      >
        <div
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            background: 'var(--color-accent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <span style={{ color: 'white', fontSize: 9, fontWeight: 700 }}>iT</span>
        </div>
        <h1 className="text-[15px] font-semibold truncate" style={{ color: 'var(--color-foreground)' }}>
          {current.name}
        </h1>
        {current.defaultUrl && (
          <span className="text-[11px] font-mono truncate" style={{ color: 'var(--color-foreground-muted)' }}>
            {current.defaultUrl}
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={() => {
            exit();
            navigate('/');
          }}
          className="flex items-center gap-1 px-3 py-1.5 rounded-[8px] text-[12px]"
          style={{
            background: 'var(--color-background-subtle)',
            border: '1px solid var(--color-glass-border)',
            color: 'var(--color-foreground-secondary)',
            cursor: 'pointer',
          }}
        >
          <Icon name="logOut" size={12} />
          退出项目
        </button>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* 二级导航 */}
        <nav
          className="shrink-0 flex flex-col"
          style={{
            width: 176,
            borderRight: '1px solid var(--color-glass-border)',
            padding: '10px 8px',
            gap: 1,
          }}
          aria-label="项目内导航"
        >
          {NAV_ITEMS.map((item) => (
            <NavRow key={item.path} to={item.path} icon={item.icon} label={item.label} />
          ))}
        </nav>
        {/* 内容区 */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <Outlet />
          {children}
        </main>
      </div>
    </div>
  );
}
