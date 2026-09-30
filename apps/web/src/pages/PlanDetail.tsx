import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import StatusPill from '../components/ui/StatusPill';
import EmptyState from '../components/ui/EmptyState';
import Button from '../components/ui/Button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/Modal';

export default function PlanDetail() {
  const { id, projectId } = useParams<{ id: string; projectId: string }>();
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [search, setSearch] = useState('');

  const { data: plan } = useQuery({
    queryKey: ['plan', id],
    queryFn: () => api.plans.get(id!),
    enabled: !!id,
  });

  const { data: allCases } = useQuery({
    queryKey: ['cases', projectId],
    queryFn: () => api.cases.list({ projectId }),
    enabled: !!projectId,
  });

  const inPlanIds = useMemo(() => new Set((plan?.cases ?? []).map((c) => c.id)), [plan]);
  const candidates = useMemo(() => {
    const list = (allCases ?? []).filter((c) => !inPlanIds.has(c.id));
    if (!search.trim()) return list;
    return list.filter((c) => c.title.includes(search.trim()));
  }, [allCases, inPlanIds, search]);

  const setCases = useMutation({
    mutationFn: (caseIds: string[]) => api.plans.setCases(id!, caseIds),
    onSuccess: () => {
      toast('用例已更新', 'success');
      qc.invalidateQueries({ queryKey: ['plan', id] });
      qc.invalidateQueries({ queryKey: ['plans', projectId] });
      setShowAdd(false);
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const remove = useMutation({
    mutationFn: () => api.plans.remove(id!),
    onSuccess: () => {
      toast('已删除', 'success');
      qc.invalidateQueries({ queryKey: ['plans', projectId] });
      navigate(`/p/${projectId}/plans`);
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const run = useMutation({
    mutationFn: () => api.plans.run(id!),
    onSuccess: (r) => {
      toast(`已启动执行 #${r.runId.slice(0, 8)}`, 'success');
      qc.invalidateQueries({ queryKey: ['executions', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  // 当 dialog 打开时重置搜索
  useEffect(() => {
    if (showAdd) setSearch('');
  }, [showAdd]);

  if (!plan) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)' }}>
        <Icon name="loader" size={16} className="animate-spin" />
        <span style={{ marginLeft: 8 }}>加载中...</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 px-6 py-3 shrink-0" style={{ borderBottom: '1px solid var(--color-glass-border)' }}>
        <button
          onClick={() => navigate(`/p/${projectId}/plans`)}
          className="flex items-center gap-1 text-[12px]"
          style={{ color: 'var(--color-foreground-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}
        >
          <Icon name="chevronLeft" size={12} />
          返回计划列表
        </button>
        <span style={{ width: 1, height: 16, background: 'var(--color-glass-border)' }} />
        <h1 className="text-[16px] font-semibold truncate" style={{ color: 'var(--color-foreground)' }}>
          {plan.name}
        </h1>
        {plan.environment && (
          <span className="text-[10px] uppercase font-semibold px-2 py-[2px] rounded-full" style={{ background: 'var(--color-background-subtle)', color: 'var(--color-foreground-muted)' }}>
            {plan.environment}
          </span>
        )}
        <div className="flex-1" />
        <Button
          variant="secondary"
          onClick={() => setShowAdd(true)}
        >
          <Icon name="plus" size={12} />
          添加用例
        </Button>
        <Button
          onClick={() => run.mutate()}
          disabled={run.isPending || plan.cases.length === 0}
        >
          <Icon name="play" size={12} />
          {run.isPending ? '执行中...' : '一键执行'}
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            if (confirm('确认删除该执行计划？')) remove.mutate();
          }}
          style={{ color: 'var(--color-destructive)' }}
        >
          <Icon name="trash" size={12} />
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6">
        <div className="glass-card rounded-[12px] p-5">
          <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-3" style={{ color: 'var(--color-foreground-muted)' }}>
            用例顺序 ({plan.cases.length})
          </div>
          {plan.cases.length === 0 ? (
            <EmptyState icon="flag" title="还没有用例" description="点击右上「添加用例」选择场景。" />
          ) : (
            <ol className="flex flex-col gap-2">
              {plan.cases.map((c, idx) => (
                <li
                  key={c.id}
                  onClick={() => navigate(`/p/${projectId}/cases/${c.id}`)}
                  className="flex items-center gap-3 px-3 py-2 rounded-[8px] cursor-pointer list-row-clickable"
                  style={{ background: 'var(--color-background-subtle)', border: '1px solid var(--color-glass-border)' }}
                >
                  <span className="text-[11px] font-mono shrink-0 w-5" style={{ color: 'var(--color-foreground-muted)' }}>
                    {idx + 1}
                  </span>
                  <span className="text-[12px] flex-1 truncate" style={{ color: 'var(--color-foreground)' }}>
                    {c.title}
                  </span>
                  <StatusPill status="default">{c.id.slice(0, 8)}</StatusPill>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent style={{ maxWidth: 540 }}>
          <DialogHeader>
            <DialogTitle>添加用例</DialogTitle>
          </DialogHeader>
          <div className="px-5 py-3">
            <div className="input-wrap">
              <Icon name="search" size={14} className="input-icon" />
              <input
                type="text"
                placeholder="搜索用例"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="input-base input-sm input-with-leading"
              />
            </div>
          </div>
          <div className="px-5 pb-4 max-h-[400px] overflow-y-auto flex flex-col gap-1">
            {candidates.length === 0 ? (
              <div className="text-[12px] py-8 text-center" style={{ color: 'var(--color-foreground-muted)' }}>
                没有可添加的用例
              </div>
            ) : (
              candidates.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center gap-2 px-3 py-2 rounded-[6px] cursor-pointer hover-card"
                  onClick={() => {
                    const next = [...plan.cases.map((x) => x.id), c.id];
                    setCases.mutate(next);
                  }}
                >
                  <Icon name="plus" size={12} style={{ color: 'var(--color-foreground-muted)' }} />
                  <span className="text-[12px] flex-1 truncate" style={{ color: 'var(--color-foreground)' }}>
                    {c.title}
                  </span>
                  <span className="text-[10px]" style={{ color: 'var(--color-foreground-muted)' }}>
                    {c.priority}
                  </span>
                </div>
              ))
            )}
          </div>
          <div className="flex justify-end px-5 py-3 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <Button variant="plain" onClick={() => setShowAdd(false)}>关闭</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
