import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUIStore } from '../stores/ui';
import { useAgentRunStore } from '../stores/agentRun';

export default function RequirementDetail() {
  const { id } = useParams<{ id: string }>();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const pushEvent = useAgentRunStore((s) => s.pushEvent);
  const clearEvents = useAgentRunStore((s) => s.clear);
  const [streaming, setStreaming] = useState(false);

  const { data: req } = useQuery({
    queryKey: ['requirement', id],
    queryFn: () => api.requirements.get(id!),
    enabled: !!id,
  });

  const generateCases = useMutation({
    mutationFn: async () => {
      clearEvents();
      const run = await api.agentRuns.create({
        targetType: 'requirement2cases',
        targetId: id!,
        prompt: req?.content ?? '',
      });
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

  if (!req) return <div className="glass-panel p-8">加载中...</div>;

  return (
    <div className="max-w-4xl flex flex-col gap-6">
      <Link to="/requirements" style={{ color: 'var(--color-text-secondary)' }}>
        ← 返回需求列表
      </Link>
      <div className="glass-panel p-6">
        <h1 className="text-2xl font-semibold mb-2">{req.title}</h1>
        <pre className="whitespace-pre-wrap text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          {req.content}
        </pre>
      </div>
      <div className="glass-panel p-6">
        <h2 className="text-lg font-semibold mb-4">Agent 操作</h2>
        <button
          className="btn-primary"
          disabled={streaming || generateCases.isPending}
          onClick={() => generateCases.mutate()}
        >
          {streaming ? '生成中...' : '⚡ 用 AI 生成用例'}
        </button>
        <p className="text-xs mt-2" style={{ color: 'var(--color-text-muted)' }}>
          将调用 Mock LLM，返回结构化用例并写入数据库。
        </p>
      </div>
    </div>
  );
}