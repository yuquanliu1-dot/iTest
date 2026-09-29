import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUIStore } from '../stores/ui';
import { useRecorderStore } from '../stores/recorder';
import { useAgentRunStore } from '../stores/agentRun';

type Tab = 'description' | 'reports' | 'recording';

export default function CaseDetail() {
  const { id } = useParams<{ id: string }>();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const recorder = useRecorderStore();
  const pushEvent = useAgentRunStore((s) => s.pushEvent);
  const clearEvents = useAgentRunStore((s) => s.clear);
  const [tab, setTab] = useState<Tab>('description');
  const [targetUrl, setTargetUrl] = useState('');
  const [streaming, setStreaming] = useState(false);
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
      window.location.href = `/reports/${r.reportId}`;
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

  if (!caseDetail) return <div className="glass-panel p-8">加载中...</div>;

  return (
    <div className="max-w-5xl flex flex-col gap-6">
      <Link to="/cases" style={{ color: 'var(--color-text-secondary)' }}>
        ← 返回用例列表
      </Link>
      <div className="glass-panel p-6">
        <h1 className="text-2xl font-semibold">{caseDetail.title}</h1>
        <p style={{ color: 'var(--color-text-muted)' }} className="text-sm mt-1">
          {caseDetail.priority} · {caseDetail.status}
        </p>
      </div>

      <div className="flex gap-2">
        {(['description', 'reports', 'recording'] as Tab[]).map((t) => (
          <button
            key={t}
            className="btn-ghost"
            style={tab === t ? { borderColor: 'var(--color-primary)', color: 'var(--color-primary)' } : {}}
            onClick={() => setTab(t)}
          >
            {t === 'description' ? '描述 / 步骤' : t === 'reports' ? '报告' : '录制历史'}
          </button>
        ))}
      </div>

      <div className="glass-panel p-6">
        {tab === 'description' && (
          <div className="flex flex-col gap-4">
            {caseDetail.description && (
              <p style={{ color: 'var(--color-text-secondary)' }}>{caseDetail.description}</p>
            )}
            <div>
              <div className="flex justify-between items-center mb-2">
                <h3 className="font-semibold">步骤 ({caseDetail.steps.length})</h3>
                <div className="flex gap-2 items-center">
                  <input
                    className="input-base"
                    style={{ width: 220 }}
                    placeholder="录制目标 URL"
                    value={targetUrl}
                    onChange={(e) => setTargetUrl(e.target.value)}
                  />
                  <button
                    className="btn-ghost"
                    disabled={streaming || genSteps.isPending}
                    onClick={() => genSteps.mutate()}
                  >
                    {streaming ? '补充中...' : '⚡ AI 补充步骤'}
                  </button>
                  <button
                    className="btn-primary"
                    disabled={execute.isPending}
                    onClick={() => execute.mutate()}
                  >
                    ▶ 执行（Mock）
                  </button>
                  {recorder.status === 'recording' ? (
                    <button className="btn-ghost" onClick={() => stopRecording.mutate()}>
                      ⏹ 停止录制
                    </button>
                  ) : (
                    <button className="btn-ghost" onClick={() => startRecording.mutate()}>
                      ▶ 录制补充
                    </button>
                  )}
                </div>
              </div>
              {caseDetail.steps.length === 0 ? (
                <p style={{ color: 'var(--color-text-muted)' }}>暂无步骤</p>
              ) : (
                <ol className="flex flex-col gap-2">
                  {caseDetail.steps.map((s) => (
                    <li key={s.id} className="p-3 rounded border text-sm" style={{ borderColor: 'rgba(0,0,0,0.08)' }}>
                      <span className="text-xs mr-2 px-1.5 py-0.5 rounded" style={{ background: 'rgba(124,92,252,0.15)', color: 'var(--color-primary)' }}>
                        {s.source}
                      </span>
                      <code className="text-xs">{JSON.stringify(s.action)}</code>
                    </li>
                  ))}
                </ol>
              )}
              {recorder.status === 'recording' && (
                <p className="text-sm mt-2" style={{ color: 'var(--color-info)' }}>
                  ● 录制中... 在 Chrome 扩展打开的页面操作即可。
                </p>
              )}
              {recorder.status === 'error' && (
                <p className="text-sm mt-2" style={{ color: 'var(--color-destructive)' }}>
                  ✕ {recorder.errorMessage}
                </p>
              )}
            </div>
          </div>
        )}
        {tab === 'reports' && (
          <Link to="/reports" style={{ color: 'var(--color-primary)' }}>
            查看该用例的所有报告 →
          </Link>
        )}
        {tab === 'recording' && (
          <p style={{ color: 'var(--color-text-muted)' }}>
            录制历史（占位，未来按时间序列展示每次录制会话）。
          </p>
        )}
      </div>
    </div>
  );
}