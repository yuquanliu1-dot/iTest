import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import Icon from '../components/Icon';
import StatusPill from '../components/ui/StatusPill';
import EmptyState from '../components/ui/EmptyState';
import { fullDateTime } from '../lib/format';

export default function PlanRunDetail() {
  const { id, runId, projectId } = useParams<{ id: string; runId: string; projectId: string }>();
  const navigate = useNavigate();
  const { data: run, isLoading } = useQuery({
    queryKey: ['planRun', runId],
    queryFn: () => api.planRuns.get(runId!),
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 2000 : false),
  });

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
        <button onClick={() => navigate(`/p/${projectId}/plans/${id}`)} className="flex items-center gap-1 text-[12px]" style={{ color: 'var(--color-foreground-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}>
          <Icon name="chevronLeft" size={12} />
          返回计划详情
        </button>
        <span style={{ width: 1, height: 16, background: 'var(--color-glass-border)' }} />
        <h1 className="text-[16px] font-semibold truncate" style={{ color: 'var(--color-foreground)' }}>计划运行</h1>
        <StatusPill status={run.status}>{run.status}</StatusPill>
        <div className="flex-1" />
        <span className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>
          {fullDateTime(run.startedAt)} · {run.durationMs ?? 0} ms
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6 flex flex-col gap-4">
        <div className="glass-card rounded-[12px] p-4 text-[13px]" style={{ color: 'var(--color-foreground-secondary)' }}>
          {run.summary ?? '执行中...'}
        </div>

        <div className="glass-card rounded-[12px] overflow-hidden">
          <div className="px-5 py-[10px]" style={{ background: 'var(--color-background-subtle)', borderBottom: '1px solid var(--color-border)' }}>
            <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>时间线</span>
          </div>
          {run.cases.length === 0 ? (
            <EmptyState icon="listChecks" title="暂无步骤" />
          ) : (
            <div className="flex flex-col">
              {run.cases.map((c) => (
                <div key={c.id} className="flex items-start gap-3 px-5 py-3" style={{ borderBottom: '1px solid var(--color-muted)' }}>
                  <span className="font-mono text-[12px] shrink-0 mt-0.5" style={{ color: c.status === 'passed' ? 'var(--color-success)' : c.status === 'failed' ? 'var(--color-destructive)' : 'var(--color-foreground-muted)' }}>
                    {c.status === 'passed' ? '✓' : c.status === 'failed' ? '✕' : '•'} #{c.order} {c.stepKind === 'login_prepare' ? '登录' : ''}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px]" style={{ color: 'var(--color-foreground)' }}>
                      <span className="font-mono text-[11px] mr-2" style={{ color: 'var(--color-foreground-muted)' }}>{c.caseId.slice(0, 8)}</span>
                      <StatusPill status={c.status}>{c.status}</StatusPill>
                      <span className="ml-2 text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>{c.durationMs ?? 0} ms</span>
                    </div>
                    {c.error && <div className="text-[12px] mt-1" style={{ color: 'var(--color-destructive)' }}>{c.error}</div>}
                  </div>
                  {c.reportId && (
                    <button
                      onClick={() => navigate(`/p/${projectId}/reports/${c.reportId}`)}
                      className="text-[11px]"
                      style={{ background: 'transparent', border: 'none', color: 'var(--color-accent)', cursor: 'pointer' }}
                    >
                      报告
                    </button>
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