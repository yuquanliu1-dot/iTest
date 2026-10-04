import { useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useProjectStore } from '../stores/project';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import EmptyState from '../components/ui/EmptyState';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/Modal';
import StatusPill from '../components/ui/StatusPill';
import { shortDateTime, fullDateTime } from '../lib/format';
import {
  PageShell,
  PageShellActions,
  PageShellContent,
  PageShellDescription,
  PageShellHeader,
  PageShellTitle,
} from '../components/layout/PageShell';

export default function Plans() {
  const { projectId, versionId } = useParams<{ projectId: string; versionId?: string }>();
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const currentVersionName = useProjectStore((s) => s.current?.versionName ?? null);
  const { data: plans, isLoading, isError, error } = useQuery({
    queryKey: ['plans', projectId, versionId ?? 'all'],
    queryFn: () => api.projects.plans(projectId!),
    enabled: !!projectId,
  });
  // 按当前 versionId 过滤（NULL 版本 = 跨版本计划也展示，但用副标记）
  const filteredPlans = (plans ?? []).filter((p) => !versionId || p.versionId == null || p.versionId === versionId);
  const { data: planRuns } = useQuery({
    queryKey: ['executions', projectId, 'plan'],
    queryFn: () => api.executions.list({ projectId, kind: 'plan' }),
    enabled: !!projectId,
  });
  const latestByPlan = useMemo(() => {
    const m = new Map<string, { status: string; summary: string | null; createdAt: string }>();
    for (const r of planRuns ?? []) {
      if (r.kind !== 'plan') continue;
      if (!m.has(r.planId)) m.set(r.planId, { status: r.status, summary: r.summary, createdAt: r.createdAt });
    }
    return m;
  }, [planRuns]);

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState('');

  const create = useMutation({
    mutationFn: () => api.projects.createPlan(projectId!, { name, environment: environment || undefined, versionId: versionId ?? undefined }),
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
    <PageShell>
      <PageShellHeader>
        <PageShellTitle>执行计划</PageShellTitle>
        <PageShellActions>
          <Button onClick={() => setShowCreate(true)}>
            <Icon name="plus" size={14} />
            新建执行计划
          </Button>
        </PageShellActions>
        <PageShellDescription>
          把用例按目标场景组合，一键运行
          {currentVersionName ? ` · ${currentVersionName}` : null}
        </PageShellDescription>
      </PageShellHeader>

      <PageShellContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-12" style={{ color: 'var(--muted-foreground)' }}>
            <Icon name="loader" size={16} className="animate-spin" />
            <span style={{ marginLeft: 8 }}>加载中...</span>
          </div>
        ) : isError ? (
          <div className="flex items-center justify-center py-12" style={{ color: 'var(--muted-foreground)', fontSize: 13 }}>
            加载失败：{error?.message ?? '未知错误'}
          </div>
        ) : !plans || plans.length === 0 ? (
          <EmptyState
            icon="flag"
            title="还没有执行计划"
            description="按场景组织用例，比如「预发冒烟」或「回归核心」。"
            action={<Button size="sm" onClick={() => setShowCreate(true)}>+ 新建执行计划</Button>}
          />
        ) : (
          <div className="grid grid-cols-3 gap-4" data-stagger>
            {filteredPlans.map((p) => (
              <div
                key={p.id}
                data-stagger-item
                onClick={() => navigate(versionId ? `/p/${projectId}/v/${versionId}/plans/${p.id}` : `/`)}
                className="bg-card border rounded-[var(--radius-md)] p-4 cursor-pointer hover-card"
              >
                <div className="flex items-center justify-between">
                  <div className="text-[14px] font-semibold truncate" style={{ color: 'var(--foreground)' }}>
                    {p.name}
                  </div>
                  <span className="text-[10px] uppercase font-semibold px-2 py-[2px] rounded-full" style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}>
                    {p.environment ?? '默认'}
                  </span>
                </div>
                <div className="text-[12px] mt-2" style={{ color: 'var(--muted-foreground)' }}>
                  {p.caseCount} 个用例
                </div>
                <div className="text-[11px] mt-1" style={{ color: 'var(--muted-foreground)' }}>
                  创建于 {fullDateTime(p.createdAt)}
                </div>
                {(() => {
                  const last = latestByPlan.get(p.id);
                  if (!last) return null;
                  return (
                    <div className="text-[11px] mt-1 flex items-center gap-2" style={{ color: 'var(--muted-foreground)' }}>
                      <StatusPill status={last.status}>{last.status}</StatusPill>
                      <span>{shortDateTime(last.createdAt)}</span>
                    </div>
                  );
                })()}
              </div>
            ))}
          </div>
        )}
      </PageShellContent>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建执行计划</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <Input label="名称" placeholder="例如：预发冒烟" value={name} onChange={(e) => setName(e.target.value)} />
            <Input label="环境（可选）" placeholder="预发 / 生产 / staging" value={environment} onChange={(e) => setEnvironment(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>取消</Button>
            <Button disabled={!name || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? '创建中...' : '创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
