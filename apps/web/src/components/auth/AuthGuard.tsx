import { useEffect } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../../stores/auth';

/** Route guard: probes the session on mount; redirects to /login if not logged in, renders child routes after login. */
export default function AuthGuard() {
  const { t } = useTranslation();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isLoading = useAuthStore((s) => s.isLoading);
  const initialize = useAuthStore((s) => s.initialize);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center" style={{ color: 'var(--muted-foreground)', fontSize: 13 }}>
        {t('common:loading')}
      </div>
    );
  }
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <Outlet />;
}
