import { Link, useLocation } from 'react-router-dom';

const navItems = [
  { path: '/', label: '总览' },
  { path: '/requirements', label: '需求' },
  { path: '/cases', label: '用例' },
  { path: '/reports', label: '报告' },
  { path: '/settings', label: '设置' },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  return (
    <div>
      <header
        style={{
          height: 64,
          display: 'flex',
          alignItems: 'center',
          padding: '0 24px',
          borderBottom: '1px solid rgba(0,0,0,0.06)',
          background: 'rgba(255,255,255,0.7)',
          backdropFilter: 'blur(12px)',
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 18, marginRight: 32, color: 'var(--color-primary)' }}>
          iTest
        </div>
        <nav style={{ display: 'flex', gap: 16 }}>
          {navItems.map((item) => {
            const active = item.path === '/' ? loc.pathname === '/' : loc.pathname.startsWith(item.path);
            return (
              <Link
                key={item.path}
                to={item.path}
                style={{
                  color: active ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                  fontWeight: active ? 600 : 400,
                  textDecoration: 'none',
                }}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>
      <main style={{ padding: 24 }}>{children}</main>
    </div>
  );
}