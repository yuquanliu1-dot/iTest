import { Navigate, Outlet, useParams } from 'react-router-dom';
import { useProjectStore } from '../../stores/project';

/** 仅校验「当前 store 与 URL 是否一致」，不再渲染独立导航——导航交给主 Sidebar。
 *  失败时回 / 让用户重新选择项目。 */
export default function ProjectGuard() {
  const { projectId } = useParams<{ projectId: string }>();
  const current = useProjectStore((s) => s.current);

  if (!current || current.id !== projectId) {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}