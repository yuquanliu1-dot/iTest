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

type Strategy = 'run_all' | 'fail_fast';

export default function PlanDetail() {
  const { id, projectId } = useParams<{ id: string; projectId: string }>();
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();

  const { data: plan } = useQuery({
    queryKey: ['plan', id],
    queryFn: () => api.plans.get(id!),
    enabled: !!id,
  });

  const [showAdd, setShowAdd] = useState(false);
  const [selectedAdd, setSelectedAdd] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

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

  const [loginQ, setLoginQ] = useState('');
  const { data: loginCases } = useQuery({
    queryKey: ['plan', id, 'login-cases', loginQ],
    queryFn: () => api.plans.loginCases(id!, loginQ),
    enabled: !!id && (plan?.loginPrepareEnabled ?? false),
  });

  const patchPlan = useMutation({
    mutationFn: (body: Parameters<typeof api.plans.patch>[1]) => api.plans.patch(id!, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plan', id] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const setCases = useMutation({
    mutationFn: (caseIds: string[]) => api.plans.setCases(id!, caseIds),
    onSuccess: () => {
      toast('用例已更新', 'success');
      qc.invalidateQueries({ queryKey: ['plan', id] });
      qc.invalidateQueries({ queryKey: ['plans', projectId] });
      setShowAdd(false);
      setSelectedAdd(new Set());
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const reorder = useMutation({
    mutationFn: (caseIds: string[]) => api.plans.reorderCases(id!, caseIds),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plan', id] });
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
      setActiveRunId(r.runId);
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const cancel = useMutation({
    mutationFn: () => api.planRuns.cancel(activeRunId!),
    onError: (e: Error) => toast(e.message, 'error'),
  });

  useEffect(() => {
    if (!activeRunId) return;
    const es = new EventSource(api.planRuns.eventsUrl(activeRunId));
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === 'plan_run_complete') {
          es.close();
          setActiveRunId(null);
          qc.invalidateQueries({ queryKey: ['plan', id] });
          qc.invalidateQueries({ queryKey: ['plans', projectId] });
          qc.invalidateQueries({ queryKey: ['executions'] });
          toast(`执行完成：${data.summary ?? ''}`, data.status === 'passed' ? 'success' : 'error');
          navigate(`/p/${projectId}/plans/${id}/runs/${activeRunId}`);
        }
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
  }, [activeRunId, id, navigate, projectId, qc, toast]);

  useEffect(() => {
    if (showAdd) setSelectedAdd(new Set());
  }, [showAdd]);

  if (!plan) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)' }}>
        <Icon name="loader" size={16} className="animate-spin" />
        <span style={{ marginLeft: 8 }}>加载中...</span>
      </div>
    );
  }

  const moveBy = (idx: number, delta: number) => {
    const list = [...(plan.cases ?? [])];
    const j = idx + delta;
    if (j < 0 || j >= list.length) return;
    [list[idx], list[j]] = [list[j]!, list[idx]!];
    reorder.mutate(list.map((c) => c.id));
  };

  const onDragStart = (e: React.DragEvent, idx: number) => {
    e.dataTransfer.setData('text/plain', String(idx));
  };
  const onDrop = (e: React.DragEvent, idx: number) => {
    const from = Number(e.dataTransfer.getData('text/plain'));
    if (Number.isNaN(from) || from === idx) return;
    const list = [...(plan.cases ?? [])];
    const [moved] = list.splice(from, 1);
    list.splice(idx, 0, moved!);
    reorder.mutate(list.map((c) => c.id));
  };

  const updateStrategy = (v: Strategy) => patchPlan.mutate({ strategy: v });
  const updateLoginPrepare = (next: { enabled?: boolean; caseId?: string | null; detectionUrl?: string | null; successSelector?: string | null; unauthorizedKeywords?: string[] | null }) => {
    patchPlan.mutate({
      loginPrepare: {
        enabled: next.enabled ?? plan.loginPrepareEnabled,
        caseId: next.caseId === undefined ? plan.loginCaseId : next.caseId,
        detectionUrl: next.detectionUrl === undefined ? plan.detectionUrl : next.detectionUrl,
        successSelector: next.successSelector === undefined ? plan.loginSuccessSelector : next.successSelector,
        unauthorizedKeywords: next.unauthorizedKeywords === undefined ? (plan.loginUnauthorizedKeywords as string[] | null) : next.unauthorizedKeywords,
      },
    });
  };

  const isRunning = !!activeRunId;

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
        <div className="flex-1" />
        <Button variant="secondary" onClick={() => setShowAdd(true)}>
          <Icon name="plus" size={12} />
          添加用例
        </Button>
        {isRunning ? (
          <Button variant="secondary" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
            <Icon name="pause" size={12} />
            中止
          </Button>
        ) : (
          <Button onClick={() => run.mutate()} disabled={run.isPending || plan.cases.length === 0}>
            <Icon name="play" size={12} />
            {run.isPending ? '启动中...' : '一键执行'}
          </Button>
        )}
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

      <div className="flex-1 min-h-0 overflow-y-auto p-6 flex flex-col gap-4">
        <div className="glass-card rounded-[12px] p-5">
          <div className="flex items-center gap-4">
            <span className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>执行策略</span>
            <select
              value={plan.strategy}
              onChange={(e) => updateStrategy(e.target.value as Strategy)}
              className="input-base input-sm"
              style={{ minWidth: 180 }}
            >
              <option value="run_all">全部执行完成</option>
              <option value="fail_fast">失败即停止</option>
            </select>
          </div>
          <div className="mt-4">
            <label className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--color-foreground-secondary)' }}>
              <input
                type="checkbox"
                checked={plan.loginPrepareEnabled}
                onChange={(e) => updateLoginPrepare({ enabled: e.target.checked })}
              />
              启用登录准备
            </label>
            {plan.loginPrepareEnabled && (
              <div className="mt-3 flex flex-col gap-2 pl-5">
                <div className="flex items-center gap-2">
                  <span className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>登录用例</span>
                  <select
                    value={plan.loginCaseId ?? ''}
                    onChange={(e) => updateLoginPrepare({ caseId: e.target.value || null })}
                    className="input-base input-sm"
                    style={{ minWidth: 240 }}
                  >
                    <option value="">— 请选择 —</option>
                    {(loginCases ?? []).map((c) => (
                      <option key={c.id} value={c.id}>{c.title}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    placeholder="搜索用例或分组"
                    value={loginQ}
                    onChange={(e) => setLoginQ(e.target.value)}
                    className="input-base input-sm"
                  />
                </div>
                <details className="text-[12px]">
                  <summary className="cursor-pointer" style={{ color: 'var(--color-foreground-muted)' }}>高级配置</summary>
                  <div className="mt-2 flex flex-col gap-2 pl-4">
                    <label className="flex flex-col gap-1">
                      <span style={{ color: 'var(--color-foreground-muted)' }}>检测页面 URL</span>
                      <input
                        type="text"
                        placeholder="留空使用第一个业务用例的 URL"
                        defaultValue={plan.detectionUrl ?? ''}
                        onBlur={(e) => updateLoginPrepare({ detectionUrl: e.target.value || null })}
                        className="input-base input-sm"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span style={{ color: 'var(--color-foreground-muted)' }}>登录成功标识（CSS 选择器）</span>
                      <input
                        type="text"
                        placeholder="例如 .user-menu"
                        defaultValue={plan.loginSuccessSelector ?? ''}
                        onBlur={(e) => updateLoginPrepare({ successSelector: e.target.value || null })}
                        className="input-base input-sm"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span style={{ color: 'var(--color-foreground-muted)' }}>未授权关键字（一行一个）</span>
                      <textarea
                        defaultValue={((plan.loginUnauthorizedKeywords as string[] | null) ?? []).join('\n')}
                        onBlur={(e) => {
                          const lines = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean);
                          updateLoginPrepare({ unauthorizedKeywords: lines.length ? lines : null });
                        }}
                        className="input-base input-sm"
                        rows={3}
                      />
                    </label>
                  </div>
                </details>
              </div>
            )}
          </div>
        </div>

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
                  draggable
                  onDragStart={(e) => onDragStart(e, idx)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => onDrop(e, idx)}
                  className="flex items-center gap-3 px-3 py-2 rounded-[8px] list-row-clickable"
                  style={{ background: 'var(--color-background-subtle)', border: '1px solid var(--color-glass-border)' }}
                >
                  <span className="cursor-grab text-[11px] font-mono shrink-0" style={{ color: 'var(--color-foreground-muted)' }}>⋮⋮</span>
                  <span className="text-[11px] font-mono shrink-0 w-5" style={{ color: 'var(--color-foreground-muted)' }}>{idx + 1}</span>
                  <span onClick={() => navigate(`/p/${projectId}/cases/${c.id}`)} className="text-[12px] flex-1 truncate cursor-pointer" style={{ color: 'var(--color-foreground)' }}>
                    {c.title}
                  </span>
                  <button onClick={() => moveBy(idx, -1)} className="text-[11px]" style={{ background: 'transparent', border: 'none', color: 'var(--color-foreground-muted)' }} aria-label="上移">
                    <Icon name="chevronUp" size={12} />
                  </button>
                  <button onClick={() => moveBy(idx, 1)} className="text-[11px]" style={{ background: 'transparent', border: 'none', color: 'var(--color-foreground-muted)' }} aria-label="下移">
                    <Icon name="chevronDown" size={12} />
                  </button>
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
              <div className="text-[12px] py-8 text-center" style={{ color: 'var(--color-foreground-muted)' }}>没有可添加的用例</div>
            ) : (
              candidates.map((c) => {
                const checked = selectedAdd.has(c.id);
                return (
                  <div
                    key={c.id}
                    className="flex items-center gap-2 px-3 py-2 rounded-[6px] cursor-pointer hover-card"
                    onClick={() => {
                      const next = new Set(selectedAdd);
                      if (checked) next.delete(c.id);
                      else next.add(c.id);
                      setSelectedAdd(next);
                    }}
                  >
                    <input type="checkbox" readOnly checked={checked} />
                    <span className="text-[12px] flex-1 truncate" style={{ color: 'var(--color-foreground)' }}>{c.title}</span>
                    <span className="text-[10px]" style={{ color: 'var(--color-foreground-muted)' }}>{c.priority}</span>
                  </div>
                );
              })
            )}
          </div>
          <div className="flex justify-between items-center px-5 py-3 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <span className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>已选 {selectedAdd.size}</span>
            <div className="flex gap-2">
              <Button variant="plain" onClick={() => setShowAdd(false)}>取消</Button>
              <Button
                disabled={selectedAdd.size === 0}
                onClick={() => {
                  const next = [...plan.cases.map((c) => c.id), ...Array.from(selectedAdd)];
                  setCases.mutate(next);
                }}
              >
                加入计划
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
