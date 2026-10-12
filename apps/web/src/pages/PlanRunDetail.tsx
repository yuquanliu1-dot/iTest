import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import Button from '../components/ui/Button';
import StatusPill from '../components/ui/StatusPill';
import EmptyState from '../components/ui/EmptyState';
import LiveViewCard from '../components/LiveViewCard';
import { fullDateTime } from '../lib/format';

export default function PlanRunDetail() {
  const { id, runId, projectId, versionId } = useParams<{ id: string; runId: string; projectId: string; versionId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useUIStore((s) => s.showToast);
  const { data: run, isLoading, isError, error } = useQuery({
    queryKey: ['planRun', runId],
    queryFn: () => api.planRuns.get(runId!),
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 2000 : false),
  });

  // 中止能力从计划详情页迁移到这里：执行即跳本页，running 期间就地中止。
  const cancel = useMutation({
    mutationFn: () => api.planRuns.cancel(runId!),
    onSuccess: () => {
      toast('已发起中止', 'success');
      qc.invalidateQueries({ queryKey: ['planRun', runId] });
      qc.invalidateQueries({ queryKey: ['executions'] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  if (isError) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--muted-foreground)', fontSize: 13 }}>
        加载失败：{error?.message ?? '未知错误'}
      </div>
    );
  }

  if (isLoading || !run) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--muted-foreground)' }}>
        <Icon name="loader" size={16} className="animate-spin" />
        <span style={{ marginLeft: 8 }}>加载中...</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 px-6 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <Button variant="ghost" size="sm" onClick={() => navigate(`/p/${projectId}/v/${versionId}/reports`)}>
          <Icon name="chevronLeft" size={12} />
          返回执行历史
        </Button>
        <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
        <h1 className="text-[16px] font-semibold truncate" style={{ color: 'var(--foreground)' }}>计划运行</h1>
        <StatusPill status={run.status}>{run.status}</StatusPill>
        <div className="flex-1" />
        {run.status === 'running' && (
          <Button variant="ghost" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
            <Icon name="pause" size={12} />
            {cancel.isPending ? '中止中...' : '中止'}
          </Button>
        )}
        <span className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
          {fullDateTime(run.startedAt)} · {run.durationMs ?? 0} ms
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6 flex flex-col gap-4">
        {/* 运行中实时画面：refetchInterval 2s 轮询 run.status，running 期间 <img> 直连 MJPEG 流；
            结束定格最后一帧 + 「回放」按钮（录制回放，不自动播）。 */}
        <LiveViewCard
          liveUrl={api.planRuns.liveUrl(run.id)}
          replayUrl={(speed) => api.planRuns.replayUrl(run.id, speed)}
          replayMetaUrl={api.planRuns.replayMetaUrl(run.id)}
          running={run.status === 'running'}
        />
        <div className="bg-card border rounded-[var(--radius-md)] p-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
          {run.summary ?? '执行中...'}
        </div>

        <div className="bg-card border rounded-[var(--radius-md)] overflow-hidden">
          <div className="px-5 py-[10px] hairline-bottom" style={{ background: 'var(--muted)' }}>
            <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--muted-foreground)' }}>时间线</span>
          </div>
          {run.cases.length === 0 ? (
            <EmptyState icon="listChecks" title="暂无步骤" />
          ) : (
            <div className="flex flex-col" data-stagger>
              {/* mobile plan-run case platform badge: requires backend exposing case.platform on run.cases[i]; tracked as follow-up */}
              {run.cases.map((c) => (
                <div key={c.id} data-stagger-item className="flex items-start gap-3 px-5 py-3 hairline-bottom">
                  <span className="font-mono text-[12px] shrink-0 mt-0.5" style={{ color: 'var(--muted-foreground)' }}>
                    #{c.order} {c.stepKind === 'login_prepare' ? '登录' : ''}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] flex items-center gap-2 flex-wrap" style={{ color: 'var(--foreground)' }}>
                      <span className="mr-1">{c.caseTitle ?? <span style={{ color: 'var(--muted-foreground)' }}>已删除用例</span>}</span>
                      <span className="font-mono text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{c.caseId.slice(0, 8)}</span>
                      <StatusPill status={c.status} pulse={c.status === 'running'}>{c.status}</StatusPill>
                      <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{c.durationMs ?? 0} ms</span>
                      {(c.reportIds?.length ?? 0) > 1 && (
                        <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                          {(c.rowStatuses ?? []).filter((s) => s === 'passed').length}/{c.reportIds!.length} 行通过
                        </span>
                      )}
                    </div>
                    {c.error && <div className="text-[12px] mt-1" style={{ color: 'var(--destructive)' }}>{c.error}</div>}
                    {/* 通过行展示最后断言结论（vision reason）；失败行 error 已含结论，不重复展示 */}
                    {!c.error && c.lastAssertion && (
                      <div className="text-[12px] mt-1 truncate" style={{ color: 'var(--muted-foreground)' }} title={c.lastAssertion}>
                        {c.lastAssertion}
                      </div>
                    )}
                  </div>
                  {(c.reportIds?.length ?? 0) > 1 ? (
                    <div className="flex items-center gap-1 shrink-0">
                      {(c.reportIds ?? []).map((rid, i) => {
                        const st = c.rowStatuses?.[i];
                        return (
                          <Button
                            key={rid}
                            variant="ghost"
                            size="sm"
                            title={st ?? undefined}
                            onClick={() => navigate(`/p/${projectId}/v/${versionId}/reports/${rid}`)}
                          >
                            行{i + 1} {st === 'passed' ? '✓' : st === 'failed' ? '✕' : '·'}
                          </Button>
                        );
                      })}
                    </div>
                  ) : (
                    c.reportId && (
                      <Button variant="ghost" size="sm" onClick={() => navigate(`/p/${projectId}/v/${versionId}/reports/${c.reportId}`)}>
                        报告
                      </Button>
                    )
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