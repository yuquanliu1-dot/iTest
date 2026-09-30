import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import EmptyState from '../components/ui/EmptyState';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/Modal';
import { fullDateTime } from '../lib/format';

export default function Plans() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const { data: plans, isLoading } = useQuery({
    queryKey: ['plans', projectId],
    queryFn: () => api.projects.plans(projectId!),
    enabled: !!projectId,
  });

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState('');

  const create = useMutation({
    mutationFn: () => api.projects.createPlan(projectId!, { name, environment: environment || undefined }),
    onSuccess: () => {
      setName('');
      setEnvironment('');
      setShowCreate(false);
      toast('执行计划已创建', 'success');
      qc.invalidateQueries({ queryKey: ['plans', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-5 pt-4 pb-0">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight" style={{ color: 'var(--color-foreground)' }}>
            执行计划
          </h1>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--color-foreground-muted)' }}>
            把用例按目标场景组合，一键运行
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-4 py-[7px] rounded-[8px] text-[13px] font-semibold bg-accent hover:bg-accent-hover active:scale-[0.97] transition-[background-color,transform] duration-150"
        >
          <Icon name="plus" size={14} />
          新建执行计划
        </button>
      </div>

      <div className="flex-1 min-h-0 px-5 pt-4 pb-5 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-12" style={{ color: 'var(--color-foreground-muted)' }}>
            <Icon name="loader" size={16} className="animate-spin" />
            <span style={{ marginLeft: 8 }}>加载中...</span>
          </div>
        ) : !plans || plans.length === 0 ? (
          <EmptyState
            icon="flag"
            title="还没有执行计划"
            description="按场景组织用例，比如「预发冒烟」或「回归核心」。"
            action={<Button size="sm" onClick={() => setShowCreate(true)}>+ 新建执行计划</Button>}
          />
        ) : (
          <div className="grid grid-cols-3 gap-4">
            {plans.map((p) => (
              <div
                key={p.id}
                onClick={() => navigate(`/p/${projectId}/plans/${p.id}`)}
                className="glass-card rounded-[12px] p-4 cursor-pointer hover-card"
              >
                <div className="flex items-center justify-between">
                  <div className="text-[14px] font-semibold truncate" style={{ color: 'var(--color-foreground)' }}>
                    {p.name}
                  </div>
                  <span className="text-[10px] uppercase font-semibold px-2 py-[2px] rounded-full" style={{ background: 'var(--color-background-subtle)', color: 'var(--color-foreground-muted)' }}>
                    {p.environment ?? '默认'}
                  </span>
                </div>
                <div className="text-[12px] mt-2" style={{ color: 'var(--color-foreground-secondary)' }}>
                  {p.caseCount} 个用例
                </div>
                <div className="text-[11px] mt-1" style={{ color: 'var(--color-foreground-muted)' }}>
                  创建于 {fullDateTime(p.createdAt)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建执行计划</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <Input label="名称" placeholder="例如：预发冒烟" value={name} onChange={(e) => setName(e.target.value)} />
            <Input label="环境（可选）" placeholder="预发 / 生产 / staging" value={environment} onChange={(e) => setEnvironment(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <Button variant="plain" onClick={() => setShowCreate(false)}>取消</Button>
            <Button disabled={!name || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? '创建中...' : '创建'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
