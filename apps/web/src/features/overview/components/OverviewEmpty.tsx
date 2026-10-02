import { useNavigate } from 'react-router-dom';
import Icon from '../../../components/Icon';

export default function OverviewEmpty({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="text-center max-w-md">
        <div className="flex justify-center">
          <Icon name="beaker" size={48} style={{ color: 'var(--color-foreground-muted)' }} />
        </div>
        <h3 className="text-[16px] font-semibold mt-3" style={{ color: 'var(--color-foreground)' }}>
          还没有用例数据
        </h3>
        <p className="text-[12px] mt-1" style={{ color: 'var(--color-foreground-muted)' }}>
          创建需求 → 生成用例 → 执行，所有指标都会汇聚到这里。
        </p>
        <div className="flex gap-2 justify-center mt-4">
          <button className="btn-primary" onClick={() => navigate(`/p/${projectId}/groups`)}>
            去新建用例
          </button>
          <button className="btn-ghost" onClick={() => navigate(`/p/${projectId}/plans`)}>
            去新建计划
          </button>
        </div>
      </div>
    </div>
  );
}
