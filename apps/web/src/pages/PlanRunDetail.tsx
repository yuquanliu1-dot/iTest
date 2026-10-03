import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import Icon from '../components/Icon';
import Button from '../components/ui/Button';
import StatusPill from '../components/ui/StatusPill';
import EmptyState from '../components/ui/EmptyState';
import { fullDateTime } from '../lib/format';

export default function PlanRunDetail() {
  const { id, runId, projectId } = useParams<{ id: string; runId: string; projectId: string }>();
  const navigate = useNavigate();
  const { data: run, isLoading, isError, error } = useQuery({
    queryKey: ['planRun', runId],
    queryFn: () => api.planRuns.get(runId!),
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 2000 : false),
  });

  if (isError) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)', fontSize: 13 }}>
        加载失败：{error?.message ?? '未知错误'}
      </div>
    );
  }

  if (isLoading || !run) {
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
        <Button variant="ghost" size="sm" onClick={() => navigate(`/p/${projectId}/plans/${id}`)}>
          <Icon name="chevronLeft" size={12} />
          返回计划详情
        </Button>
        <span style={{ width: 1, height: 16, background: 'var(--color-glass-border)' }} />
        <h1 className="text-[16px] font-semibold truncate" style={{ color: 'var(--color-foreground)' }}>计划运行</h1>
        <StatusPill status={run.status}>{run.status}</StatusPill>
        <div className="flex-1" />
        <span className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>
          {fullDateTime(run.startedAt)} · {run.durationMs ?? 0} ms
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6 flex flex-col gap-4">
        <div className="glass-card rounded-[var(--radius-md)] p-4 text-[13px]" style={{ color: 'var(--color-foreground-secondary)' }}>
          {run.summary ?? '执行中...'}
        </div>

        <div className="glass-card rounded-[var(--radius-md)] overflow-hidden">
          <div className="px-5 py-[10px] hairline-bottom" style={{ background: 'var(--color-background-subtle)' }}>
            <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>时间线</span>
          </div>
          {run.cases.length === 0 ? (
            <EmptyState icon="listChecks" title="暂无步骤" />
          ) : (
            <div className="flex flex-col" data-stagger>
              {run.cases.map((c) => (
                <div key={c.id} data-stagger-item className="flex items-start gap-3 px-5 py-3 hairline-bottom">
                  <span className="font-mono text-[12px] shrink-0 mt-0.5" style={{ color: 'var(--color-foreground-muted)' }}>
                    #{c.order} {c.stepKind === 'login_prepare' ? '登录' : ''}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] flex items-center gap-2 flex-wrap" style={{ color: 'var(--color-foreground)' }}>
                      <span className="mr-1">{c.caseTitle ?? <span style={{ color: 'var(--color-foreground-muted)' }}>已删除用例</span>}</span>
                      <span className="font-mono text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>{c.caseId.slice(0, 8)}</span>
                      <StatusPill status={c.status} pulse={c.status === 'running'}>{c.status}</StatusPill>
                      <span className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>{c.durationMs ?? 0} ms</span>
                    </div>
                    {c.error && <div className="text-[12px] mt-1" style={{ color: 'var(--color-destructive)' }}>{c.error}</div>}
                  </div>
                  {c.reportId && (
                    <Button variant="ghost" size="sm" onClick={() => navigate(`/p/${projectId}/reports/${c.reportId}`)}>
                      报告
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}