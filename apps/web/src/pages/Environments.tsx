import { useParams } from 'react-router-dom';
import { useProjectStore } from '../stores/project';
import ProjectEnvironments from './ProjectEnvironments';

export default function Environments() {
  const { projectId } = useParams<{ projectId: string }>();
  const current = useProjectStore((s) => s.current);
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-5 pt-4 pb-0">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight" style={{ color: 'var(--color-foreground)' }}>
            测试环境
          </h1>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--color-foreground-muted)' }}>
            环境配置 · {current?.name ?? projectId}
          </p>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        <ProjectEnvironments projectId={projectId!} />
      </div>
    </div>
  );
}