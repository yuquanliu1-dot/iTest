import { useEffect } from 'react';
import { Navigate, Outlet, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useProjectStore } from '../../stores/project';
import Icon from '../Icon';

/** 除「store 与 URL 一致」外，还校验项目真实存在且对当前用户可见。
 *  与 ProjectsHome 共用 ['projects'] 缓存，常规导航命中缓存不会多发请求。 */
export default function ProjectGuard() {
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
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)', fontSize: 13 }}>
        加载失败：{error?.message ?? '未知错误'}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)', fontSize: 13 }}>
        <Icon name="loader" size={16} className="animate-spin" />
        <span style={{ marginLeft: 8 }}>加载中...</span>
      </div>
    );
  }

  if (!data?.some((p) => p.id === projectId)) {
    // localStorage 残留的无效项目：清掉再弹回，避免下次深链又被放行
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
