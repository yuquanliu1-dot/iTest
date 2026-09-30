import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUIStore } from '../stores/ui';
import { useRecorderStore } from '../stores/recorder';
import { useAgentRunStore } from '../stores/agentRun';
import { useStepClipboard, type StepClip } from '../stores/stepClipboard';
import Icon from '../components/Icon';
import StatusPill from '../components/ui/StatusPill';
import PriorityBadge from '../components/ui/PriorityBadge';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Segmented from '../components/ui/Segmented';
import EmptyState from '../components/ui/EmptyState';
import AgentStreamPanel from '../components/ui/AgentStreamPanel';
import StepEditModal from '../components/StepEditModal';

type Tab = 'description' | 'reports' | 'recording';

/** 步骤身份快照比较：用于检测并发 mutation 是否动了我们正在编辑的那一行。 */
function sameStep(a: StepClip, b: StepClip): boolean {
  return JSON.stringify(a.action) === JSON.stringify(b.action);
}

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
  const clipboard = useStepClipboard();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<StepClip | null>(null);
  const editingIdxRef = useRef<number>(-1);
  const editingSnapshotRef = useRef<StepClip | null>(null);
  const historyRef = useRef<StepClip[][]>([]);

  const toClip = (s: { action: unknown; source: string; name?: string | null; delayMs?: number | null }): StepClip => ({
    action: s.action,
    source: s.source,
    name: s.name ?? undefined,
    delayMs: s.delayMs ?? undefined,
  });

  const replaceSteps = useMutation({
    mutationFn: (steps: StepClip[]) =>
      api.cases.replaceSteps(
        id!,
        steps.map((s) => ({ ...s, name: s.name ?? undefined, delayMs: s.delayMs ?? undefined })),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['case', id] }),
    onError: (e: Error) => toast(e.message, 'error'),
  });

  /** 所有步骤变更统一入口：先记撤销快照，再全量替换。 */
  const mutateSteps = (updater: (steps: StepClip[]) => StepClip[]) => {
    if (!caseDetail) return;
    const current = caseDetail.steps.map(toClip);
    historyRef.current.push(current);
    if (historyRef.current.length > 20) historyRef.current.shift();
    replaceSteps.mutate(updater(current));
  };

  const undo = () => {
    const snapshot = historyRef.current.pop();
    if (!snapshot) {
      toast('没有可撤销的操作', 'info');
      return;
    }
    replaceSteps.mutate(snapshot);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo]);

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
      // 先走扩展的 flush 握手：等 background 把队列里的 step 发完、服务端关闭 WS，
      // 再调 finish HTTP——否则尾部步骤可能还在 WS 飞行中，finish 会漏写。
      await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (v: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          window.removeEventListener('message', onMsg);
          resolve(v);
        };
        const onMsg = (e: MessageEvent) => {
          if (e.data?.source === 'ita-ext' && e.data?.type === 'stop-result') finish(!!e.data.ok);
        };
        const timer = setTimeout(() => finish(false), 5000);
        window.addEventListener('message', onMsg);
        window.postMessage({ source: 'ita-web', type: 'stop-recording', sessionId }, '*');
      });
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

  const deleteStep = useMutation({
    mutationFn: (stepId: string) => api.cases.deleteStep(id!, stepId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['case', id] }),
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const moveStep = useMutation({
    mutationFn: ({ stepId, dir }: { stepId: string; dir: -1 | 1 }) => {
      if (!caseDetail) throw new Error('case not loaded');
      const ids = caseDetail.steps.map((s) => s.id);
      const i = ids.indexOf(stepId);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= ids.length) throw new Error('cannot move');
      [ids[i], ids[j]] = [ids[j]!, ids[i]!];
      return api.cases.reorderSteps(id!, ids);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['case', id] }),
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
          执行
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
                <div className="flex items-center gap-2 mb-3">
                  <div className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>
                    步骤 ({caseDetail.steps.length})
                  </div>
                  <div className="flex-1" />
                  <button
                    onClick={() => {
                      const clips = caseDetail.steps.filter((s) => selected.has(s.id)).map(toClip);
                      if (clips.length === 0) {
                        toast('先勾选要复制的步骤', 'info');
                        return;
                      }
                      clipboard.setSteps(clips);
                      toast(`已复制 ${clips.length} 个步骤`, 'success');
                    }}
                    disabled={selected.size === 0}
                    className="text-[11px] px-2 py-1 rounded-[6px]"
                    style={{ border: '1px solid var(--color-glass-border)', background: 'transparent', color: 'var(--color-foreground-secondary)', cursor: selected.size === 0 ? 'default' : 'pointer', opacity: selected.size === 0 ? 0.4 : 1 }}
                  >
                    复制选中 ({selected.size})
                  </button>
                  <button
                    onClick={() =>
                      mutateSteps((cur) => {
                        const afterIdx =
                          selected.size === 1 ? cur.findIndex((_, i) => caseDetail.steps[i]!.id === [...selected][0]) : cur.length - 1;
                        const at = afterIdx < 0 ? cur.length - 1 : afterIdx;
                        const next = [...cur];
                        next.splice(at + 1, 0, ...clipboard.steps.map((c) => ({ ...c })));
                        return next;
                      })
                    }
                    disabled={clipboard.steps.length === 0}
                    className="text-[11px] px-2 py-1 rounded-[6px]"
                    style={{ border: '1px solid var(--color-glass-border)', background: 'transparent', color: 'var(--color-foreground-secondary)', cursor: clipboard.steps.length === 0 ? 'default' : 'pointer', opacity: clipboard.steps.length === 0 ? 0.4 : 1 }}
                  >
                    粘贴 ({clipboard.steps.length})
                  </button>
                  <button
                    onClick={undo}
                    disabled={historyRef.current.length === 0}
                    className="text-[11px] px-2 py-1 rounded-[6px]"
                    style={{ border: '1px solid var(--color-glass-border)', background: 'transparent', color: 'var(--color-foreground-secondary)', cursor: 'pointer', opacity: historyRef.current.length === 0 ? 0.4 : 1 }}
                  >
                    撤销
                  </button>
                </div>
                {caseDetail.steps.length === 0 ? (
                  <EmptyState
                    icon="listChecks"
                    title="暂无步骤"
                    description="点击右侧「AI 补充步骤」让 Agent 起草，或用 Chrome 扩展录制。"
                  />
                ) : (
                  <ol className="flex flex-col gap-2">
                    {caseDetail.steps.map((s, idx) => (
                      <li
                        key={s.id}
                        className="flex items-center gap-3 px-3 py-2 rounded-[8px]"
                        style={{ background: 'var(--color-background-subtle)', border: '1px solid var(--color-glass-border)' }}
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(s.id)}
                          onChange={(e) => {
                            const next = new Set(selected);
                            if (e.target.checked) next.add(s.id);
                            else next.delete(s.id);
                            setSelected(next);
                          }}
                          style={{ accentColor: 'var(--color-accent)' }}
                        />
                        <span className="text-[10px] uppercase font-semibold tracking-wide shrink-0" style={{ color: 'var(--color-accent)' }}>
                          {s.source}
                        </span>
                        <span className="text-[11px] font-mono shrink-0 w-5" style={{ color: 'var(--color-foreground-muted)' }}>
                          {idx + 1}
                        </span>
                        <code className="text-[12px] font-mono flex-1 break-all" style={{ color: 'var(--color-foreground)' }}>
                          {JSON.stringify(s.action)}
                        </code>
                        {(s.action as { kind?: string; compiled?: unknown[] | null }).kind === 'aiStep' &&
                          (s.action as { compiled?: unknown[] | null }).compiled == null && (
                            <button
                              onClick={() => {
                                const instruction = (s.action as { instruction?: string }).instruction ?? '';
                                api.cases
                                  .recompileStep(id!, instruction)
                                  .then((r) => {
                                    if (!r.compiled) {
                                      toast('重新编译失败', 'error');
                                      return;
                                    }
                                    let applied = false;
                                    mutateSteps((cur) => {
                                      const i = cur.findIndex((c) => {
                                        const a = c.action as { kind?: string; instruction?: string };
                                        return a.kind === 'aiStep' && a.instruction === instruction;
                                      });
                                      if (i < 0) return cur;
                                      applied = true;
                                      const next = [...cur];
                                      next[i] = { ...next[i]!, action: { ...(next[i]!.action as object), compiled: r.compiled } };
                                      return next;
                                    });
                                    // applied 在 mutateSteps 内部同步置位；HTTP 失败时此路径不会跑到这里
                                    toast(applied ? '编译成功' : '步骤已被修改，请刷新后重试', applied ? 'success' : 'error');
                                  })
                                  .catch((e: Error) => toast(e.message, 'error'));
                              }}
                              className="text-[10px] px-2 py-0.5 rounded-full shrink-0"
                              style={{ border: '1px solid #b45309', color: '#b45309', background: 'transparent', cursor: 'pointer' }}
                            >
                              AI 编译失败 · 点我重编
                            </button>
                          )}
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => moveStep.mutate({ stepId: s.id, dir: -1 })}
                            disabled={idx === 0 || moveStep.isPending}
                            title="上移"
                            style={{ background: 'transparent', border: 'none', cursor: idx === 0 ? 'default' : 'pointer', color: 'var(--color-foreground-muted)', opacity: idx === 0 ? 0.3 : 1, padding: 2 }}
                          >
                            <Icon name="chevronUp" size={12} />
                          </button>
                          <button
                            onClick={() => moveStep.mutate({ stepId: s.id, dir: 1 })}
                            disabled={idx === caseDetail.steps.length - 1 || moveStep.isPending}
                            title="下移"
                            style={{ background: 'transparent', border: 'none', cursor: idx === caseDetail.steps.length - 1 ? 'default' : 'pointer', color: 'var(--color-foreground-muted)', opacity: idx === caseDetail.steps.length - 1 ? 0.3 : 1, padding: 2 }}
                          >
                            <Icon name="chevronDown" size={12} />
                          </button>
                          <button
                            onClick={() => {
                              editingIdxRef.current = idx;
                              editingSnapshotRef.current = toClip(s);
                              setEditing(toClip(s));
                            }}
                            title="编辑"
                            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-foreground-muted)', padding: 2 }}
                          >
                            <Icon name="pencil" size={12} />
                          </button>
                          <button
                            onClick={() => deleteStep.mutate(s.id)}
                            disabled={deleteStep.isPending}
                            title="删除"
                            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-destructive)', padding: 2 }}
                          >
                            <Icon name="trash" size={12} />
                          </button>
                        </div>
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
      {editing && (
        <StepEditModal
          initial={editing}
          availableVars={caseDetail.steps
            .map((s) => (s.action as { kind?: string; varName?: string }).kind === 'extract'
              ? (s.action as { varName: string }).varName
              : undefined)
            .filter((v): v is string => !!v)}
          onClose={() => setEditing(null)}
          onSave={(next) => {
            let applied = false;
            mutateSteps((cur) => {
              const i = editingIdxRef.current;
              const prev = editingSnapshotRef.current;
              const curAt = cur[i];
              if (!curAt || !prev || !sameStep(curAt, prev)) return cur;
              applied = true;
              const newCur = [...cur];
              newCur[i] = next;
              return newCur;
            });
            if (!applied) toast('步骤已被修改，请关闭弹窗重试', 'error');
            setEditing(null);
            editingSnapshotRef.current = null;
          }}
        />
      )}
    </div>
  );
}