import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUIStore } from '../stores/ui';
import { useRecorderStore } from '../stores/recorder';
import { useAgentRunStore } from '../stores/agentRun';
import Icon from '../components/Icon';
import StatusPill from '../components/ui/StatusPill';
import PriorityBadge from '../components/ui/PriorityBadge';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Segmented from '../components/ui/Segmented';
import EmptyState from '../components/ui/EmptyState';
import AgentStreamPanel from '../components/ui/AgentStreamPanel';

type Tab = 'description' | 'reports' | 'recording';

export default function CaseDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const recorder = useRecorderStore();
  const pushEvent = useAgentRunStore((s) => s.pushEvent);
  const clearEvents = useAgentRunStore((s) => s.clear);
  const [tab, setTab] = useState<Tab>('description');
  const [targetUrl, setTargetUrl] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);

  const { data: caseDetail } = useQuery({
    queryKey: ['case', id],
    queryFn: () => api.cases.get(id!),
    enabled: !!id,
  });

  const startRecording = useMutation({
    mutationFn: async () => {
      const session = await api.recorder.createSession(id!);
      recorder.setStatus('recording');
      recorder.setSession(session.sessionId);
      sessionRef.current = session.sessionId;
      const ok = await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (v: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          window.removeEventListener('message', onMsg);
          resolve(v);
        };
        const onMsg = (e: MessageEvent) => {
          if (e.data?.source === 'ita-ext' && e.data?.type === 'start-result') finish(!!e.data.ok);
        };
        const timer = setTimeout(() => finish(false), 3000);
        window.addEventListener('message', onMsg);
        window.postMessage(
          {
            source: 'ita-web',
            type: 'start-recording',
            session: { wsUrl: session.wsUrl, sessionId: session.sessionId, token: session.wsToken },
            targetUrl,
          },
          '*',
        );
      });
      if (!ok) {
        recorder.setError('请确认已加载 Chrome 录制扩展');
        sessionRef.current = null;
      }
    },
    onError: (e: Error) => {
      recorder.setError(e.message);
      toast(e.message, 'error');
    },
  });

  const stopRecording = useMutation({
    mutationFn: async () => {
      const sessionId = recorder.sessionId;
      if (!sessionId) throw new Error('no active session');
      window.postMessage({ source: 'ita-web', type: 'stop-recording', sessionId }, '*');
      const r = await api.recorder.finish(sessionId);
      sessionRef.current = null;
      recorder.reset();
      toast(`已写入 ${r.inserted} 个步骤`, 'success');
      qc.invalidateQueries({ queryKey: ['case', id] });
    },
  });

  const genSteps = useMutation({
    mutationFn: async () => {
      if (!caseDetail) throw new Error('case not loaded');
      clearEvents();
      const run = await api.agentRuns.create({
        targetType: 'case2script',
        targetId: id!,
        prompt: JSON.stringify({
          title: caseDetail.title,
          description: caseDetail.description,
          steps: caseDetail.steps.map((s) => s.action),
        }),
      });
      setStreaming(true);
      setActiveRunId(run.id);
      return new Promise<void>((resolve, reject) => {
        const es = new EventSource(api.agentRuns.eventsUrl(run.id));
        es.onmessage = (e) => {
          try {
            const payload = JSON.parse(e.data);
            pushEvent({ type: payload.type, payload });
            if (payload.type === 'workflow_complete') {
              es.close();
              setStreaming(false);
              toast('步骤已补充', 'success');
              qc.invalidateQueries({ queryKey: ['case', id] });
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
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const execute = useMutation({
    mutationFn: () => api.cases.execute(id!),
    onSuccess: (r) => {
      toast('执行完成', 'success');
      qc.invalidateQueries({ queryKey: ['reports'] });
      navigate(`/reports/${r.reportId}`);
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  useEffect(() => {
    return () => {
      if (sessionRef.current) {
        window.postMessage({ source: 'ita-web', type: 'stop-recording', sessionId: sessionRef.current }, '*');
        sessionRef.current = null;
      }
    };
  }, []);

  if (!caseDetail) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)' }}>
        <Icon name="loader" size={16} className="animate-spin" />
        <span style={{ marginLeft: 8 }}>加载中...</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header bar */}
      <div className="flex items-center gap-3 px-6 py-3 shrink-0" style={{ borderBottom: '1px solid var(--color-glass-border)' }}>
        <button
          onClick={() => navigate('/cases')}
          className="flex items-center gap-1 text-[12px]"
          style={{ color: 'var(--color-foreground-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}
        >
          <Icon name="arrowLeft" size={12} />
          返回用例列表
        </button>
        <span style={{ width: 1, height: 16, background: 'var(--color-glass-border)' }} />
        <h1 className="text-[16px] font-semibold truncate" style={{ color: 'var(--color-foreground)' }}>
          {caseDetail.title}
        </h1>
        <PriorityBadge priority={caseDetail.priority} />
        <StatusPill status={caseDetail.status}>{caseDetail.status}</StatusPill>
        <div className="flex-1" />
        <Button
          variant="secondary"
          onClick={() => execute.mutate()}
          disabled={execute.isPending || caseDetail.steps.length === 0}
        >
          <Icon name="play" size={12} />
          执行（Mock）
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 px-6 py-3 shrink-0">
        <Segmented
          options={[
            { value: 'description', label: '描述 / 步骤', icon: 'list' },
            { value: 'reports', label: '报告', icon: 'flag' },
            { value: 'recording', label: '录制历史', icon: 'clock' },
          ]}
          value={tab}
          onChange={(v) => setTab(v)}
        />
      </div>

      {/* Body — 主区 + 右侧操作侧栏 */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="flex gap-5 px-6 pb-6">
          <div className="flex-1 min-w-0 flex flex-col gap-4">
            {tab === 'description' && (
              <div className="flex flex-col gap-4">
                <AgentStreamPanel
                  runId={activeRunId}
                  streaming={streaming}
                  errorMessage={(genSteps.error as Error | null)?.message}
                />
                <div className="glass-card rounded-[12px] p-5">
                <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-3" style={{ color: 'var(--color-foreground-muted)' }}>
                  {caseDetail.description ? '描述' : '（无描述）'}
                </div>
                {caseDetail.description && (
                  <p className="text-[13px] mb-4" style={{ color: 'var(--color-foreground-secondary)', lineHeight: 1.7 }}>
                    {caseDetail.description}
                  </p>
                )}
                <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-3" style={{ color: 'var(--color-foreground-muted)' }}>
                  步骤 ({caseDetail.steps.length})
                </div>
                {caseDetail.steps.length === 0 ? (
                  <EmptyState
                    icon="listChecks"
                    title="暂无步骤"
                    description="点击右侧「AI 补充步骤」让 Agent 起草，或用 Chrome 扩展录制。"
                  />
                ) : (
                  <ol className="flex flex-col gap-2">
                    {caseDetail.steps.map((s) => (
                      <li
                        key={s.id}
                        className="flex items-start gap-3 px-3 py-2 rounded-[8px]"
                        style={{ background: 'var(--color-background-subtle)', border: '1px solid var(--color-glass-border)' }}
                      >
                        <span className="text-[10px] uppercase font-semibold tracking-wide shrink-0" style={{ color: 'var(--color-accent)' }}>
                          {s.source}
                        </span>
                        <code className="text-[12px] font-mono flex-1 break-all" style={{ color: 'var(--color-foreground)' }}>
                          {JSON.stringify(s.action)}
                        </code>
                      </li>
                    ))}
                  </ol>
                )}
                {recorder.status === 'recording' && (
                  <p className="text-[12px] mt-3 flex items-center gap-2" style={{ color: 'var(--color-info)' }}>
                    <span className="status-pulse" style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />
                    录制中... 在 Chrome 扩展打开的页面操作即可。
                  </p>
                )}
                {recorder.status === 'error' && (
                  <p className="text-[12px] mt-3" style={{ color: 'var(--color-destructive)' }}>
                    ✕ {recorder.errorMessage}
                  </p>
                )}
                </div>
              </div>
            )}

            {tab === 'reports' && (
              <div className="glass-card rounded-[12px] p-5">
                <EmptyState icon="flag" title="前往报告列表查看" description="该用例所有执行报告已汇总到报告页。" action={
                  <Button size="sm" onClick={() => navigate('/reports')}>打开报告页</Button>
                } />
              </div>
            )}

            {tab === 'recording' && (
              <div className="glass-card rounded-[12px] p-5">
                <p className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>
                  录制历史（占位，未来按时间序列展示每次录制会话）。
                </p>
              </div>
            )}
          </div>

          {/* Right rail — 操作面板 */}
          <div className="w-[280px] shrink-0 flex flex-col gap-3">
            <div className="glass-card rounded-[12px] p-4">
              <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-3" style={{ color: 'var(--color-foreground-muted)' }}>
                AI 补充
              </div>
              <p className="text-[12px] mb-3" style={{ color: 'var(--color-foreground-secondary)' }}>
                用 AI 根据标题/描述/已有步骤补充更多脚本步骤。
              </p>
              <Button onClick={() => genSteps.mutate()} disabled={streaming || genSteps.isPending} className="w-full">
                <Icon name="bolt" size={12} />
                {streaming ? '补充中...' : 'AI 补充步骤'}
              </Button>
            </div>

            <div className="glass-card rounded-[12px] p-4">
              <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-3" style={{ color: 'var(--color-foreground-muted)' }}>
                浏览器录制
              </div>
              <Input
                label="录制目标 URL"
                placeholder="https://example.com"
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
                size="sm"
                className="mb-3"
              />
              {recorder.status === 'recording' ? (
                <Button variant="secondary" onClick={() => stopRecording.mutate()} className="w-full">
                  <Icon name="pause" size={12} />
                  停止录制
                </Button>
              ) : (
                <Button onClick={() => startRecording.mutate()} className="w-full">
                  <Icon name="play" size={12} />
                  录制补充
                </Button>
              )}
              <p className="text-[11px] mt-2" style={{ color: 'var(--color-foreground-muted)' }}>
                需先加载 Chrome 录制扩展（apps/recorder/）。
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}