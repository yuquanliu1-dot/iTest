import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUIStore } from '../stores/ui';
import { useAgentRunStore } from '../stores/agentRun';
import Icon from '../components/Icon';
import StatusPill from '../components/ui/StatusPill';
import Button from '../components/ui/Button';
import AgentStreamPanel from '../components/ui/AgentStreamPanel';
import { fullDateTime } from '../lib/format';

export default function RequirementDetail() {
  const { id, projectId } = useParams<{ id: string; projectId: string }>();
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const pushEvent = useAgentRunStore((s) => s.pushEvent);
  const clearEvents = useAgentRunStore((s) => s.clear);
  const [streaming, setStreaming] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [targetGroupId, setTargetGroupId] = useState<string>('');

  const { data: req } = useQuery({
    queryKey: ['requirement', id],
    queryFn: () => api.requirements.get(id!),
    enabled: !!id,
  });

  const { data: groups } = useQuery({
    queryKey: ['groups', projectId],
    queryFn: () => api.projects.groups(projectId!),
    enabled: !!projectId,
  });

  // 首次加载分组时默认选第一个；用户手动切换后不再覆盖。
  useEffect(() => {
    if (!targetGroupId && groups && groups.length > 0) setTargetGroupId(groups[0]!.id);
  }, [groups, targetGroupId]);

  const generateCases = useMutation({
    mutationFn: async () => {
      if (!targetGroupId) throw new Error('请选择目标分组');
      clearEvents();
      const run = await api.agentRuns.create({
        targetType: 'requirement2cases',
        targetId: id!,
        prompt: req?.content ?? '',
        targetGroupId,
      });
      setActiveRunId(run.id);
      setStreaming(true);
      return new Promise<void>((resolve, reject) => {
        const es = new EventSource(api.agentRuns.eventsUrl(run.id));
        es.onmessage = (e) => {
          try {
            const payload = JSON.parse(e.data);
            pushEvent({ type: payload.type, payload });
            if (payload.type === 'workflow_complete') {
              es.close();
              setStreaming(false);
              qc.invalidateQueries({ queryKey: ['requirement', id] });
              qc.invalidateQueries({ queryKey: ['requirements'] });
              qc.invalidateQueries({ queryKey: ['cases'] });
              qc.invalidateQueries({ queryKey: ['groups', projectId] });
              qc.invalidateQueries({ queryKey: ['cases', projectId] });
              qc.invalidateQueries({ queryKey: ['project-stats', projectId] });
              toast('用例已生成', 'success');
              resolve();
            }
            if (payload.type === 'workflow_error') {
              es.close();
              setStreaming(false);
              const msg = typeof payload.error === 'string' ? payload.error : '生成失败';
              toast(msg, 'error');
              reject(new Error(msg));
            }
          } catch {
            /* ignore */
          }
        };
        es.onerror = () => {
          es.close();
          setStreaming(false);
          reject(new Error('SSE connection failed'));
        };
      });
    },
  });

  if (!req) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)' }}>
        <Icon name="loader" size={16} className="animate-spin" />
        <span style={{ marginLeft: 8 }}>加载中...</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header bar — iDO 详情页顶部规范：面包屑 + 标题 + 状态 + 主操作 */}
      <div className="flex items-center gap-3 px-6 py-3 shrink-0" style={{ borderBottom: '1px solid var(--color-glass-border)' }}>
        <button
          onClick={() => navigate(`/p/${projectId}/requirements`)}
          className="flex items-center gap-1 text-[12px]"
          style={{ color: 'var(--color-foreground-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}
        >
          <Icon name="chevronLeft" size={12} />
          返回需求列表
        </button>
        <span style={{ width: 1, height: 16, background: 'var(--color-glass-border)' }} />
        <h1 className="text-[16px] font-semibold truncate" style={{ color: 'var(--color-foreground)' }}>
          {req.title}
        </h1>
        <StatusPill status={req.status}>{req.status}</StatusPill>
        <div className="flex-1" />
        <select
          className="input-base input-sm"
          style={{ width: 160 }}
          value={targetGroupId}
          onChange={(e) => setTargetGroupId(e.target.value)}
          disabled={streaming || generateCases.isPending}
        >
          <option value="">目标分组…</option>
          {(groups ?? []).map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
        <Button onClick={() => generateCases.mutate()} disabled={streaming || generateCases.isPending || !targetGroupId}>
          <Icon name="bolt" size={12} />
          {streaming ? '生成中...' : 'AI 生成用例'}
        </Button>
      </div>

      {/* Body — 描述主区 + 右侧 metadata 侧栏 */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="flex gap-5 p-6">
          <div className="flex-1 min-w-0 flex flex-col gap-4">
            <div className="glass-card rounded-[12px] p-5">
              <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-3" style={{ color: 'var(--color-foreground-muted)' }}>
                需求描述
              </div>
              <pre className="whitespace-pre-wrap text-[13px] leading-[1.7]" style={{ color: 'var(--color-foreground-secondary)', fontFamily: 'inherit' }}>
                {req.content}
              </pre>
            </div>
            <AgentStreamPanel runId={activeRunId} streaming={streaming} errorMessage={(generateCases.error as Error | null)?.message} />
          </div>

          <div className="w-[280px] shrink-0 flex flex-col gap-3">
            <div className="glass-card rounded-[12px] p-4">
              <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-3" style={{ color: 'var(--color-foreground-muted)' }}>
                元数据
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex justify-between text-[12px]">
                  <span style={{ color: 'var(--color-foreground-muted)' }}>创建时间</span>
                  <span style={{ color: 'var(--color-foreground-secondary)' }}>{fullDateTime(req.createdAt)}</span>
                </div>
                <div className="flex justify-between text-[12px]">
                  <span style={{ color: 'var(--color-foreground-muted)' }}>更新时间</span>
                  <span style={{ color: 'var(--color-foreground-secondary)' }}>{fullDateTime(req.updatedAt)}</span>
                </div>
                <div className="flex justify-between text-[12px]">
                  <span style={{ color: 'var(--color-foreground-muted)' }}>需求 ID</span>
                  <span className="font-mono text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>{req.id.slice(0, 8)}</span>
                </div>
              </div>
            </div>
            <div className="glass-card rounded-[12px] p-4">
              <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-2" style={{ color: 'var(--color-foreground-muted)' }}>
                AI 提示
              </div>
              <p className="text-[12px]" style={{ color: 'var(--color-foreground-secondary)' }}>
                优先使用 settings 中的 LLM 配置；未配置时降级为 mock provider。
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}