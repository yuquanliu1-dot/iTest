import { useEffect } from 'react';
import { Navigate, Outlet, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useProjectStore } from '../../stores/project';
import Icon from '../Icon';

/** ProjectGuard only validates project visibility (matches store.id + exists on the server).
 *  Version context is written to the store when "entering" from the ProjectsHome version row; versioned nested paths are handled by the /v/:versionId segment.
 *  Shares the ['projects'] cache with ProjectsHome, so regular navigation hits the cache without extra requests. */
export default function ProjectGuard() {
  const { t } = useTranslation();
  const { projectId } = useParams<{ projectId: string }>();
  const current = useProjectStore((s) => s.current);
  const exit = useProjectStore((s) => s.exit);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['projects'],
    queryFn: api.projects.list,
  });

  if (!current || current.id !== projectId) {
    return <Navigate to="/" replace />;
  }

  if (isError) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--muted-foreground)', fontSize: 13 }}>
        {t('common:loadFailed')}：{error?.message ?? t('common:unknownError')}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--muted-foreground)', fontSize: 13 }}>
        <Icon name="loader" size={16} className="animate-spin" />
        <span style={{ marginLeft: 8 }}>{t('common:loading')}</span>
      </div>
    );
  }

  if (!data?.some((p) => p.id === projectId)) {
    // Invalid project left over in localStorage: clear it and bounce back so the next deep link isn't waved through again
    return <InvalidProject onExit={exit} />;
  }

  return <Outlet />;
}

function InvalidProject({ onExit }: { onExit: () => void }) {
  useEffect(() => {
    onExit();
  }, [onExit]);
  return <Navigate to="/" replace />;
}
