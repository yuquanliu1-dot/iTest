import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type VariableReport } from '../api/client';
import { useUIStore } from '../stores/ui';
import { useRecorderStore } from '../stores/recorder';
import { useAgentRunStore } from '../stores/agentRun';
import { useStepClipboard, type StepClip } from '../stores/stepClipboard';
import Icon from '../components/Icon';
import CaseStatusMenu from '../components/CaseStatusMenu';
import PriorityBadge from '../components/ui/PriorityBadge';
import Button from '../components/ui/Button';
import IconButton from '../components/ui/IconButton';
import Input from '../components/ui/Input';
import Segmented from '../components/ui/Segmented';
import Toggle from '../components/ui/Toggle';
import EmptyState from '../components/ui/EmptyState';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/Modal';
import AgentStreamPanel from '../components/ui/AgentStreamPanel';
import StepEditDrawer from '../components/StepEditDrawer';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import SortableStepRow from '../components/step-form/SortableStepRow';
import TagChip from '../components/ui/Tag';
import LabelsManagerDialog from '../components/labels/LabelsManagerDialog';
import { stepKindLabel } from '../lib/format';
import { stepSummary } from '../lib/stepSummary';

type Tab = 'description' | 'reports' | 'recording';

/** 步骤身份快照比较：用于检测并发 mutation 是否动了我们正在编辑的那一行。 */
function sameStep(a: StepClip, b: StepClip): boolean {
  return JSON.stringify(a.action) === JSON.stringify(b.action);
}

export default function CaseDetail() {
  const { id, projectId, versionId } = useParams<{ id: string; projectId: string; versionId?: string }>();
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
  const [mode, setMode] = useState<'fresh' | 'append' | 'resume' | 'incognito'>('fresh');
  const [resumeTarget, setResumeTarget] = useState<{ stepId: string; order: number } | null>(null);
  const [confirmResume, setConfirmResume] = useState<{ stepId: string; order: number } | null>(null);
  /** 删除步骤前一律先弹 modal —— 步骤误删需重新录制或编辑回填。 */
  const [confirmDeleteStep, setConfirmDeleteStep] = useState<{ stepId: string; order: number; instruction: string } | null>(null);
  /** Track 1：用例级预期描述（自然语言）。回放结束由 vision LLM 拿最终截图比对。
   *  编辑与保存走 caseDetail.expectedOutcome 同步；用 ref 跟踪 serverKey 避免 refetch 静默覆盖未保存编辑。 */
  const [expectedOutcome, setExpectedOutcome] = useState('');
  const expectedOutcomeSyncRef = useRef<string | null>(null);
  const clipboard = useStepClipboard();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<StepClip | null>(null);
  const [editingIdx, setEditingIdx] = useState(-1);
  const [varReport, setVarReport] = useState<VariableReport | null>(null);
  const [windowStrategy, setWindowStrategy] = useState<'maximize' | 'current' | 'custom'>('maximize');
  const [windowWidth, setWindowWidth] = useState<number | undefined>();
  const [windowHeight, setWindowHeight] = useState<number | undefined>();
  const [incognito, setIncognito] = useState(false);
  const [defaultEnvId, setDefaultEnvId] = useState<string | null>(null);
  const [urlDialogOpen, setUrlDialogOpen] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  const [urlSaving, setUrlSaving] = useState(false);
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
    onSuccess: (r) => {
      setVarReport(r.variableReport ?? null);
      qc.invalidateQueries({ queryKey: ['case', id] });
    },
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
    // 抽屉打开时步骤列表可能已被并发变更（行号会错位），先关抽屉再撤销
    if (editing) {
      toast('请先关闭编辑抽屉再撤销', 'info');
      return;
    }
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

  const { data: caseDetail, isError, error } = useQuery({
    queryKey: ['case', id],
    queryFn: () => api.cases.get(id!),
    enabled: !!id,
  });

  // 录制目标 URL 实时跟随"初始化导航 URL"（用例.url → 分组.defaultUrl → 环境.base_url 解析结果）。
  // 用户手动改过之后不再被 caseDetail refetch 静默覆盖；点输入框右侧"↺"可恢复继承链结果。
  const targetUrlDirtyRef = useRef(false);
  useEffect(() => {
    if (!caseDetail?.resolvedUrl) return;
    if (targetUrlDirtyRef.current) return;
    setTargetUrl(caseDetail.resolvedUrl);
  }, [caseDetail?.resolvedUrl]);

  // 执行设置有未保存的本地编辑时，避免被 caseDetail refetch 静默覆盖
  const runtimeSyncRef = useRef<string | null>(null);
  useEffect(() => {
    if (!caseDetail) return;
    const serverKey = JSON.stringify([
      (caseDetail.windowStrategy as 'maximize' | 'current' | 'custom') ?? 'maximize',
      caseDetail.windowWidth ?? undefined,
      caseDetail.windowHeight ?? undefined,
      !!caseDetail.incognito,
      caseDetail.defaultEnvId ?? null,
    ]);
    const localKey = JSON.stringify([windowStrategy, windowWidth, windowHeight, incognito, defaultEnvId]);
    if (runtimeSyncRef.current !== null && localKey !== runtimeSyncRef.current) return;
    runtimeSyncRef.current = serverKey;
    setWindowStrategy((caseDetail.windowStrategy as 'maximize' | 'current' | 'custom') ?? 'maximize');
    setWindowWidth(caseDetail.windowWidth ?? undefined);
    setWindowHeight(caseDetail.windowHeight ?? undefined);
    setIncognito(!!caseDetail.incognito);
    setDefaultEnvId(caseDetail.defaultEnvId ?? null);
  }, [caseDetail, windowStrategy, windowWidth, windowHeight, incognito, defaultEnvId]);

  // expectedOutcome 与服务端同步：与 runtimeSyncRef 同源模式(serverKey 比对,未保存编辑不覆盖)
  useEffect(() => {
    if (!caseDetail) return;
    const serverValue = caseDetail.expectedOutcome ?? '';
    if (expectedOutcomeSyncRef.current !== null && expectedOutcome !== expectedOutcomeSyncRef.current) return;
    expectedOutcomeSyncRef.current = serverValue;
    setExpectedOutcome(serverValue);
  }, [caseDetail, expectedOutcome]);

  const { data: groups } = useQuery({
    queryKey: ['groups', projectId],
    queryFn: () => api.projects.groups(projectId!),
    enabled: !!projectId,
  });
  const group = groups?.find((g) => g.id === caseDetail?.groupId);

  const { data: scenarios } = useQuery({
    queryKey: ['scenarios', caseDetail?.requirementId],
    queryFn: () => api.scenarios.listForRequirement(caseDetail!.requirementId!),
    enabled: !!caseDetail?.requirementId,
  });

  const { data: projectTags } = useQuery({
    queryKey: ['tags', projectId],
    queryFn: () => api.tags.list(projectId!),
    enabled: !!projectId,
  });

  const { data: environments } = useQuery({
    queryKey: ['environments', projectId],
    queryFn: () => api.environments.list(projectId!),
    enabled: !!projectId,
  });

  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const [labelsManagerOpen, setLabelsManagerOpen] = useState(false);
  const [tagSearch, setTagSearch] = useState('');
  const [tagPickerAnchor, setTagPickerAnchor] = useState<{ top: number; left: number } | null>(null);
  const tagPickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!tagPickerOpen) return;
    setTagPickerAnchor(null);
    const trigger = tagPickerRef.current?.querySelector('[data-tag-trigger]') as HTMLElement | null;
    if (trigger) {
      const rect = trigger.getBoundingClientRect();
      setTagPickerAnchor({ top: rect.bottom + 4, left: Math.max(8, rect.right - 256) });
    }
    const onClick = (e: MouseEvent) => {
      if (tagPickerRef.current && !tagPickerRef.current.contains(e.target as Node)) setTagPickerOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [tagPickerOpen]);

  const caseTagIds = useMemo(() => (caseDetail?.tags ?? []).map((t) => t.id), [caseDetail?.tags]);
  const filteredTags = useMemo(() => {
    const list = projectTags ?? [];
    if (!tagSearch.trim()) return list;
    const q = tagSearch.trim().toLowerCase();
    return list.filter((t) => t.name.toLowerCase().includes(q));
  }, [projectTags, tagSearch]);

  const setTags = useMutation({
    mutationFn: (nextIds: string[]) => api.cases.patch(id!, { tagIds: nextIds }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['case', id] });
      qc.invalidateQueries({ queryKey: ['cases', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const toggleTag = (tagId: string) => {
    const next = caseTagIds.includes(tagId)
      ? caseTagIds.filter((x) => x !== tagId)
      : [...caseTagIds, tagId];
    setTags.mutate(next);
  };

  const startRecording = useMutation({
    mutationFn: async () => {
      const opts: Parameters<typeof api.recorder.createSession>[1] = { mode };
      if (mode === 'resume' && resumeTarget) opts.resumeFromOrder = resumeTarget.order + 1;
      if (mode === 'incognito') opts.incognito = true;
      if (targetUrl) opts.targetUrl = targetUrl;
      const session = await api.recorder.createSession(id!, opts);
      recorder.setStatus('recording');
      recorder.setSession(session.sessionId);
      sessionRef.current = session.sessionId;
      if (!targetUrl && session.resolvedUrl) setTargetUrl(session.resolvedUrl);
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
            session: { wsUrl: session.wsUrl, sessionId: session.sessionId, token: session.wsToken, mode: opts.mode, ...(opts.incognito ? { incognito: true } : {}) },
            // 字段为空时回退到服务端解析的继承 URL；setTargetUrl 是异步的，不能依赖本次闭包里的 state
            targetUrl: targetUrl || session.resolvedUrl || '',
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
      setTargetUrl('');
      toast(`已写入 ${r.inserted} 个步骤`, 'success');
      qc.invalidateQueries({ queryKey: ['case', id] });
    },
  });

  // 面板/弹窗里点「停止录制」时，扩展会通知本页收尾（与 stopRecording 的尾部逻辑一致）
  useEffect(() => {
    const onStopped = (e: MessageEvent) => {
      if (e.data?.source !== 'ita-ext' || e.data?.type !== 'recording-stopped') return;
      const sessionId = recorder.sessionId;
      if (!sessionId) return;
      sessionRef.current = null;
      recorder.reset();
      api.recorder
        .finish(sessionId)
        .then((r) => {
          toast(`已写入 ${r.inserted} 个步骤`, 'success');
          qc.invalidateQueries({ queryKey: ['case', id] });
        })
        .catch((err: Error) => toast(err.message, 'error'));
    };
    window.addEventListener('message', onStopped);
    return () => window.removeEventListener('message', onStopped);
  }, [recorder, id, qc, toast]);

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

  const moveGroup = useMutation({
    mutationFn: (groupId: string) => api.cases.patch(id!, { groupId }),
    onSuccess: () => {
      toast('已移动分组', 'success');
      qc.invalidateQueries({ queryKey: ['case', id] });
      qc.invalidateQueries({ queryKey: ['cases', projectId] });
      qc.invalidateQueries({ queryKey: ['groups', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const moveScenario = useMutation({
    mutationFn: (scenarioId: string | null) => api.cases.patch(id!, { scenarioId }),
    onSuccess: () => {
      toast('已切换场景', 'success');
      qc.invalidateQueries({ queryKey: ['case', id] });
      qc.invalidateQueries({ queryKey: ['cases', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const execute = useMutation({
    mutationFn: () => api.cases.execute(id!),
    onSuccess: (r) => {
      toast('执行完成', 'success');
      qc.invalidateQueries({ queryKey: ['reports'] });
      navigate(`/p/${projectId}/v/${versionId}/reports/${r.reportId}`);
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const deleteStep = useMutation({
    mutationFn: (stepId: string) => api.cases.deleteStep(id!, stepId),
    onSuccess: () => {
      setConfirmDeleteStep(null);
      qc.invalidateQueries({ queryKey: ['case', id] });
    },
    onError: (e: Error) => {
      toast(e.message, 'error');
      setConfirmDeleteStep(null);
    },
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

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  // 拖拽预压入、尚未被服务端确认的撤销快照；reorder 失败时按引用撤出，避免污染撤销栈
  const pendingDragSnapshotsRef = useRef<StepClip[][] | null>(null);

  const dragReorder = useMutation({
    mutationFn: (stepIds: string[]) => api.cases.reorderSteps(id!, stepIds),
    onSuccess: () => {
      pendingDragSnapshotsRef.current = null;
      qc.invalidateQueries({ queryKey: ['case', id] });
    },
    onError: (e: Error) => {
      for (const snap of pendingDragSnapshotsRef.current ?? []) {
        const i = historyRef.current.indexOf(snap);
        if (i >= 0) historyRef.current.splice(i, 1);
      }
      pendingDragSnapshotsRef.current = null;
      toast(e.message, 'error');
      qc.invalidateQueries({ queryKey: ['case', id] });
    },
  });

  const onDragEnd = (e: DragEndEvent) => {
    if (!caseDetail) return;
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = caseDetail.steps.findIndex((s) => s.id === active.id);
    const newIdx = caseDetail.steps.findIndex((s) => s.id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    // 拖拽走 reorder（保 step id）；撤销快照手动入栈，undo 用 replaceSteps 恢复
    const snapshot = caseDetail.steps.map(toClip);
    historyRef.current.push(snapshot);
    if (historyRef.current.length > 20) historyRef.current.shift();
    pendingDragSnapshotsRef.current = [...(pendingDragSnapshotsRef.current ?? []), snapshot];
    dragReorder.mutate(arrayMove(caseDetail.steps.map((s) => s.id), oldIdx, newIdx));
  };

  const saveRuntime = useMutation({
    mutationFn: () =>
      api.cases.patch(id!, {
        windowStrategy,
        windowWidth,
        windowHeight,
        incognito,
        defaultEnvId,
        // Track 1：与运行设置一并保存；空字符串视作清空（传 null）
        expectedOutcome: expectedOutcome.trim() ? expectedOutcome : null,
      }),
    onSuccess: () => {
      expectedOutcomeSyncRef.current = expectedOutcome.trim() ? expectedOutcome : '';
      qc.invalidateQueries({ queryKey: ['case', id] });
      toast('已保存', 'success');
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

  if (isError) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--muted-foreground)', fontSize: 13 }}>
        加载失败：{error?.message ?? '未知错误'}
      </div>
    );
  }

  if (!caseDetail) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--muted-foreground)' }}>
        <Icon name="loader" size={16} className="animate-spin" />
        <span style={{ marginLeft: 8 }}>加载中...</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header bar */}
      <div className="flex items-center gap-3 px-6 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(`/p/${projectId}/v/${versionId}/groups/${caseDetail.groupId ?? ''}`)}
        >
          <Icon name="chevronLeft" size={12} />
          {group?.name ?? '用例列表'}
        </Button>
        <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
        <h1 className="text-[16px] font-semibold truncate" style={{ color: 'var(--foreground)' }}>
          {caseDetail.title}
        </h1>
        <PriorityBadge priority={caseDetail.priority} />
        <CaseStatusMenu caseId={caseDetail.id} status={caseDetail.status} projectId={projectId} />
        <div className="flex-1" />
        <Button
          variant="ghost"
          onClick={() => {
            if (caseDetail.status === 'deprecated' && !window.confirm('用例已废弃，仍要执行？')) return;
            execute.mutate();
          }}
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
                <div className="bg-card border rounded-[var(--radius-md)] p-5 flex flex-col gap-4">
                  <div className="text-[13px] font-medium" style={{ color: 'var(--foreground)' }}>执行设置</div>
                  <div className="flex flex-col gap-2">
                    <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>窗口策略</span>
                    <Segmented
                      value={windowStrategy}
                      onChange={setWindowStrategy}
                      options={[
                        { label: '默认最大化', value: 'maximize' },
                        { label: '当前窗口', value: 'current' },
                        { label: '自定义', value: 'custom' },
                      ]}
                    />
                  </div>
                  {windowStrategy === 'custom' && (
                    <div className="flex gap-3">
                      <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                        宽
                        <Input
                          type="number"
                          value={windowWidth ?? ''}
                          onChange={(e) => setWindowWidth(e.target.value === '' ? undefined : Number(e.target.value))}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                        高
                        <Input
                          type="number"
                          value={windowHeight ?? ''}
                          onChange={(e) => setWindowHeight(e.target.value === '' ? undefined : Number(e.target.value))}
                        />
                      </label>
                    </div>
                  )}
                  <div className="flex items-center gap-3">
                    <Toggle checked={incognito} onChange={setIncognito} label="无痕模式" />
                    <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                      每次回放从新会话开始，不保留登录态
                    </span>
                  </div>
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>默认环境</span>
                    <select
                      className="input-base input-sm"
                      value={defaultEnvId ?? ''}
                      onChange={(e) => setDefaultEnvId(e.target.value || null)}
                      disabled={(environments ?? []).length === 0}
                    >
                      <option value="">不在用例层指定</option>
                      {(environments ?? []).map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {/* Track 1：用例级预期描述。回放结束后由 vision LLM 拿最终截图比对；
                      步骤级 assertion 在回放层已被收紧为「指定元素可见」才生效，整页模糊断言一律跳过。 */}
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] flex items-center gap-1" style={{ color: 'var(--muted-foreground)' }}>
                      用例预期（最终页面应是什么样）
                      <Icon name="info" size={10} style={{ opacity: 0.5 }} />
                    </span>
                    <textarea
                      className="input-base"
                      style={{ minHeight: 64, resize: 'vertical', fontSize: 12 }}
                      placeholder="例:空字段提交后,登录框出现红色提示『请输入用户名和密码』。"
                      value={expectedOutcome}
                      onChange={(e) => setExpectedOutcome(e.target.value)}
                    />
                    <span className="text-[10px]" style={{ color: 'var(--muted-foreground)' }}>
                      留空则跳过用例级 vision 判定,用例成败只看所有步骤是否全部执行成功。
                    </span>
                  </label>
                  <div className="flex justify-end">
                    <Button onClick={() => saveRuntime.mutate()} disabled={saveRuntime.isPending}>保存</Button>
                  </div>
                </div>
                <AgentStreamPanel
                  runId={activeRunId}
                  streaming={streaming}
                  errorMessage={(genSteps.error as Error | null)?.message}
                />
                <div className="bg-card border rounded-[var(--radius-md)] p-5">
                <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-3" style={{ color: 'var(--muted-foreground)' }}>
                  {caseDetail.description ? '描述' : '（无描述）'}
                </div>
                {caseDetail.description && (
                  <p className="text-[13px] mb-4" style={{ color: 'var(--muted-foreground)', lineHeight: 1.7 }}>
                    {caseDetail.description}
                  </p>
                )}
                <div
                  className="rounded-[var(--radius-sm)] px-3 py-2 mb-4 flex items-center gap-2 text-[11px]"
                  style={{
                    border: '1px solid var(--border)',
                    color: 'var(--muted-foreground)',
                    background: 'var(--muted)',
                  }}
                >
                  <Icon name="link" size={11} style={{ opacity: 0.6 }} />
                  <span className="font-medium" style={{ color: 'var(--muted-foreground)' }}>初始化导航 URL</span>
                  <span className="flex-1 truncate font-mono" title={caseDetail.resolvedUrl ?? ''}>
                    {caseDetail.resolvedUrl ?? '未配置（回放将以 about:blank 开始）'}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setUrlDraft(caseDetail.url ?? '');
                      setUrlDialogOpen(true);
                    }}
                  >
                    {caseDetail.url ? '编辑覆盖' : '设为独立 URL'}
                  </Button>
                </div>
                <div className="flex items-center gap-2 mb-3">
                  <div className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--muted-foreground)' }}>
                    步骤 ({caseDetail.steps.length})
                  </div>
                  <div className="flex-1" />
                  <Button
                    variant="ghost"
                    size="sm"
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
                  >
                    复制选中 ({selected.size})
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      mutateSteps((cur) => {
                        const selIdx = cur
                          .map((_, i) => (selected.has(caseDetail.steps[i]!.id) ? i : -1))
                          .filter((i) => i >= 0);
                        const at = selIdx.length > 0 ? selIdx[selIdx.length - 1]! : cur.length - 1;
                        const next = [...cur];
                        next.splice(at + 1, 0, ...clipboard.steps.map((c) => ({ ...c })));
                        return next;
                      })
                    }
                    disabled={clipboard.steps.length === 0}
                    title={selected.size > 0 ? '插入到最后一个选中步骤之后' : '追加到末尾'}
                  >
                    粘贴 ({clipboard.steps.length})
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={undo}
                    disabled={historyRef.current.length === 0}
                  >
                    撤销
                  </Button>
                </div>
                {varReport &&
                  (varReport.undefined.length > 0 ||
                    varReport.forwardRefs.length > 0 ||
                    varReport.duplicates.length > 0 ||
                    varReport.invalidNames.length > 0) && (
                  <div
                    className="rounded-[var(--radius-sm)] px-3 py-2 mb-3 text-[11px]"
                    style={{ border: '1px solid var(--warning-soft-border)', color: 'var(--warning)', background: 'var(--warning-soft)' }}
                  >
                    <div className="font-semibold mb-1">变量体检提示（不阻断保存，回放时未定义变量会报错）</div>
                    <ul className="list-disc pl-4 flex flex-col gap-0.5">
                      {varReport.undefined.map((i, k) => (
                        <li key={`u${k}`}>
                          步骤 {i.stepOrder + 1} 引用了未定义变量 {`{{${i.name}}}`}（{i.field}）
                        </li>
                      ))}
                      {varReport.forwardRefs.map((i, k) => (
                        <li key={`f${k}`}>
                          步骤 {i.stepOrder + 1} 前向引用 {`{{${i.name}}}`}（定义在后面的步骤）
                        </li>
                      ))}
                      {varReport.duplicates.map((i, k) => (
                        <li key={`d${k}`}>
                          变量 {i.name} 在步骤 {i.definedAt.map((n) => n + 1).join('、')} 重复定义，回放取最后一次赋值
                        </li>
                      ))}
                      {varReport.invalidNames.map((i, k) => (
                        <li key={`n${k}`}>
                          步骤 {i.stepOrder + 1} 变量名 {i.name} 不合法：{i.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {caseDetail.steps.length === 0 ? (
                  <EmptyState
                    icon="listChecks"
                    title="暂无步骤"
                    description="点击右侧「AI 补充步骤」让 Agent 起草，或用 Chrome 扩展录制。"
                  />
                ) : (
                  <DndContext
                    sensors={recorder.status === 'recording' ? [] : sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={onDragEnd}
                  >
                    <SortableContext items={caseDetail.steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
                      <ol className="flex flex-col gap-2">
                        {caseDetail.steps.map((s, idx) => (
                          <SortableStepRow key={s.id} id={s.id} disabled={recorder.status === 'recording'} isEditing={idx === editingIdx}>
                            <input
                              type="checkbox"
                              checked={selected.has(s.id)}
                              onChange={(e) => {
                                const next = new Set(selected);
                                if (e.target.checked) next.add(s.id);
                                else next.delete(s.id);
                                setSelected(next);
                              }}
                              style={{ accentColor: 'var(--primary)' }}
                            />
                            <span className="text-[10px] uppercase font-semibold tracking-wide shrink-0" style={{ color: 'var(--primary)' }}>
                              {s.source}
                            </span>
                            <span className="text-[11px] font-mono shrink-0 w-5" style={{ color: 'var(--muted-foreground)' }}>
                              {idx + 1}
                            </span>
                            <span className="text-[12px] flex-1 truncate" style={{ color: 'var(--foreground)' }} title={stepSummary(s.action)}>
                              <span className="text-[10px] font-semibold" style={{ color: 'var(--primary)' }}>
                                {stepKindLabel((s.action as { kind?: string }).kind ?? '')}
                              </span>{' '}
                              {stepSummary(s.action)}
                            </span>
                            {(s.action as { kind?: string; varName?: string }).kind === 'extract' && (
                              <span
                                className="text-[10px] px-2 py-0.5 rounded-full shrink-0 font-mono"
                                style={{ border: '1px solid var(--primary)', color: 'var(--primary)', background: 'var(--popover)' }}
                                title="抽取变量，供后续步骤 {{引用}}"
                              >
                                → {`{{${(s.action as { varName?: string }).varName ?? ''}}}`}
                              </span>
                            )}
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
                                  className="text-[10px] px-2 py-0.5 rounded-full shrink-0 press"
                                  style={{ border: '1px solid var(--warning-soft-border)', color: 'var(--warning)', background: 'var(--warning-soft)', cursor: 'pointer' }}
                                >
                                  AI 编译失败 · 点我重编
                                </button>
                              )}
                            <div className="flex items-center gap-1 shrink-0">
                              <IconButton
                                icon="copy"
                                title="复制此步骤到下一行"
                                disabled={recorder.status === 'recording'}
                                onClick={() => {
                                  mutateSteps((cur) => {
                                    const next = [...cur];
                                    next.splice(idx + 1, 0, { ...toClip(s) });
                                    return next;
                                  });
                                }}
                              />
                              <IconButton
                                icon="chevronUp"
                                title="上移"
                                disabled={idx === 0 || moveStep.isPending}
                                onClick={() => moveStep.mutate({ stepId: s.id, dir: -1 })}
                              />
                              <IconButton
                                icon="chevronDown"
                                title="下移"
                                disabled={idx === caseDetail.steps.length - 1 || moveStep.isPending}
                                onClick={() => moveStep.mutate({ stepId: s.id, dir: 1 })}
                              />
                              <IconButton
                                icon="chevronRight"
                                title="从这里开始录制"
                                disabled={recorder.status === 'recording'}
                                onClick={() => {
                                  setConfirmResume({ stepId: s.id, order: idx });
                                }}
                              />
                              <IconButton
                                icon="pencil"
                                title="编辑"
                                onClick={() => {
                                  editingIdxRef.current = idx;
                                  setEditingIdx(idx);
                                  editingSnapshotRef.current = toClip(s);
                                  setEditing(toClip(s));
                                }}
                              />
                              <IconButton
                                icon="trash"
                                title="删除"
                                tone="destructive"
                                disabled={deleteStep.isPending}
                                onClick={() => setConfirmDeleteStep({ stepId: s.id, order: s.order, instruction: s.name ?? `第 ${s.order} 步` })}
                              />
                            </div>
                          </SortableStepRow>
                        ))}
                      </ol>
                    </SortableContext>
                  </DndContext>
                )}
                {recorder.status === 'recording' && (
                  <p className="text-[12px] mt-3 flex items-center gap-2" style={{ color: 'var(--info)' }}>
                    <span className="status-pulse" style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />
                    录制中... 在 Chrome 扩展打开的页面操作即可。
                  </p>
                )}
                {recorder.status === 'error' && (
                  <p className="text-[12px] mt-3" style={{ color: 'var(--destructive)' }}>
                    ✕ {recorder.errorMessage}
                  </p>
                )}
                </div>
              </div>
            )}

            {tab === 'reports' && (
              <div className="bg-card border rounded-[var(--radius-md)] p-5">
                <EmptyState icon="flag" title="前往报告列表查看" description="该用例所有执行报告已汇总到报告页。" action={
                  <Button size="sm" onClick={() => navigate(`/p/${projectId}/v/${versionId}/reports`)}>打开报告页</Button>
                } />
              </div>
            )}

            {tab === 'recording' && (
              <div className="bg-card border rounded-[var(--radius-md)] p-5">
                <p className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
                  录制历史（占位，未来按时间序列展示每次录制会话）。
                </p>
              </div>
            )}
          </div>

          {/* Right rail — 操作面板 */}
          <div className="w-[280px] shrink-0 flex flex-col gap-3">
            <div className="bg-card border rounded-[var(--radius-md)] p-4 relative" ref={tagPickerRef} style={{ overflow: 'visible', zIndex: tagPickerOpen ? 30 : 'auto' }}>
              <div
                data-tag-trigger
                className="text-[11px] font-medium uppercase tracking-[0.03em] mb-2 flex items-center gap-1 cursor-pointer select-none"
                style={{ color: 'var(--muted-foreground)' }}
                onClick={() => setTagPickerOpen((v) => !v)}
              >
                标签
                <Icon name="chevronDown" size={10} style={{ opacity: 0.4 }} />
              </div>
              <div className="flex flex-wrap gap-1.5 min-h-[24px]">
                {(caseDetail.tags ?? []).length === 0 ? (
                  <span className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>无</span>
                ) : (
                  (caseDetail.tags ?? []).map((t) => (
                    <TagChip
                      key={t.id}
                      tag={t}
                      onRemove={() => toggleTag(t.id)}
                    />
                  ))
                )}
              </div>
              {tagPickerOpen && tagPickerAnchor && createPortal(
                <div
                  className="rounded-[var(--radius-sm)] overflow-hidden popover-in"
                  style={{
                    position: 'fixed',
                    top: tagPickerAnchor.top,
                    left: tagPickerAnchor.left,
                    width: 256,
                    zIndex: 9999,
                    border: '1px solid var(--border)',
                    background: 'var(--card)',
                    boxShadow: 'var(--shadow-2xl)',
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <div className="px-2 py-1.5 border-b" style={{ borderColor: 'var(--border)' }}>
                    <input
                      type="text"
                      placeholder="搜索标签"
                      value={tagSearch}
                      onChange={(e) => setTagSearch(e.target.value)}
                      className="input-base input-sm"
                      autoFocus
                    />
                  </div>
                  <div className="max-h-56 overflow-y-auto py-1">
                    {filteredTags.length === 0 ? (
                      <div className="px-3 py-2 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
                        {(projectTags ?? []).length === 0 ? '项目内还没有标签' : '没有匹配'}
                      </div>
                    ) : (
                      filteredTags.map((t) => (
                        <label
                          key={t.id}
                          className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-[var(--muted)]"
                        >
                          <input
                            type="checkbox"
                            checked={caseTagIds.includes(t.id)}
                            onChange={() => toggleTag(t.id)}
                            className="w-3.5 h-3.5 rounded-[3px]"
                            style={{ accentColor: 'var(--primary)' }}
                          />
                          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: `#${t.color}` }} />
                          <span className="text-[12px] truncate" style={{ color: 'var(--foreground)' }}>{t.name}</span>
                        </label>
                      ))
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start"
                    style={{ borderTop: '1px solid var(--border)' }}
                    onClick={() => { setTagPickerOpen(false); setLabelsManagerOpen(true); }}
                  >
                    管理标签 →
                  </Button>
                </div>,
                document.body
              )}
            </div>

            <div className="bg-card border rounded-[var(--radius-md)] p-4">
              <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-2" style={{ color: 'var(--muted-foreground)' }}>
                所属分组
              </div>
              <select
                className="input-base input-sm"
                value={caseDetail.groupId ?? ''}
                disabled={moveGroup.isPending}
                onChange={(e) => moveGroup.mutate(e.target.value)}
              >
                {(groups ?? []).map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
              <p className="text-[11px] mt-2" style={{ color: 'var(--muted-foreground)' }}>
                录制目标 URL 解析链：用例 URL → 分组域名 → 项目域名。
              </p>
            </div>

            <div className="bg-card border rounded-[var(--radius-md)] p-4">
              <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-2" style={{ color: 'var(--muted-foreground)' }}>
                所属场景
              </div>
              <select
                className="input-base input-sm"
                value={caseDetail.scenarioId ?? ''}
                disabled={moveScenario.isPending || !caseDetail.requirementId}
                onChange={(e) => moveScenario.mutate(e.target.value || null)}
              >
                <option value="">（无）</option>
                {(scenarios ?? []).map((s) => (
                  <option key={s.id} value={s.id}>{s.title}</option>
                ))}
              </select>
              {!caseDetail.requirementId && (
                <p className="text-[11px] mt-2" style={{ color: 'var(--muted-foreground)' }}>
                  该用例未绑定需求，无法关联场景。
                </p>
              )}
            </div>

            <div className="bg-card border rounded-[var(--radius-md)] p-4">
              <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-3" style={{ color: 'var(--muted-foreground)' }}>
                AI 补充
              </div>
              <p className="text-[12px] mb-3" style={{ color: 'var(--muted-foreground)' }}>
                用 AI 根据标题/描述/已有步骤补充更多脚本步骤。
              </p>
              <Button onClick={() => genSteps.mutate()} disabled={streaming || genSteps.isPending} className="w-full">
                <Icon name="bolt" size={12} />
                {streaming ? '补充中...' : 'AI 补充步骤'}
              </Button>
            </div>

            <div className="bg-card border rounded-[var(--radius-md)] p-4">
              <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-3" style={{ color: 'var(--muted-foreground)' }}>
                浏览器录制
              </div>
              <select
                className="input-base input-sm mb-2"
                value={mode}
                onChange={(e) => setMode(e.target.value as typeof mode)}
                disabled={recorder.status === 'recording'}
              >
                <option value="fresh">全新录制（覆盖旧步骤）</option>
                <option value="append">追加录制（保留旧步骤）</option>
                <option value="resume">从这里开始</option>
                <option value="incognito">无痕录制</option>
              </select>
              {mode === 'resume' && (
                <p className="text-[11px] mb-2" style={{ color: 'var(--info)' }}>
                  请在步骤列表中点「从这里开始」选择目标步骤。
                </p>
              )}
              <div className="flex items-end gap-2 mb-3">
                <Input
                  label="录制目标 URL"
                  placeholder="https://example.com"
                  value={targetUrl}
                  onChange={(e) => {
                    targetUrlDirtyRef.current = true;
                    setTargetUrl(e.target.value);
                  }}
                  size="sm"
                  className="flex-1"
                />
                <IconButton
                  icon="refresh"
                  title="用初始化导航 URL 覆盖"
                  disabled={!caseDetail?.resolvedUrl || targetUrl === caseDetail.resolvedUrl}
                  onClick={() => {
                    targetUrlDirtyRef.current = false;
                    setTargetUrl(caseDetail?.resolvedUrl ?? '');
                  }}
                />
              </div>
              {recorder.status === 'recording' ? (
                <Button variant="ghost" onClick={() => stopRecording.mutate()} className="w-full">
                  <Icon name="pause" size={12} />
                  停止录制
                </Button>
              ) : (
                <Button
                  onClick={() => {
                    if (mode === 'resume' && !resumeTarget) {
                      toast('请先在步骤列表里选「从这里开始」指定步骤', 'info');
                      return;
                    }
                    startRecording.mutate();
                  }}
                  className="w-full"
                >
                  <Icon name="play" size={12} />
                  录制补充
                </Button>
              )}
              <p className="text-[11px] mt-2" style={{ color: 'var(--muted-foreground)' }}>
                需先加载 Chrome 录制扩展（apps/recorder/）。
              </p>
            </div>
          </div>
        </div>
      </div>
      {editing && (
        <StepEditDrawer
          initial={editing}
          availableVars={caseDetail.steps
            .map((s) => (s.action as { kind?: string; varName?: string }).kind === 'extract'
              ? (s.action as { varName: string }).varName
              : undefined)
            .filter((v): v is string => !!v)}
          caseId={id}
          onClose={() => { setEditing(null); setEditingIdx(-1); editingSnapshotRef.current = null; }}
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
            if (!applied) toast('步骤已被修改，请关闭抽屉重试', 'error');
            setEditing(null);
            setEditingIdx(-1);
            editingSnapshotRef.current = null;
          }}
        />
      )}

      {projectId && (
        <LabelsManagerDialog
          open={labelsManagerOpen}
          projectId={projectId}
          onClose={() => setLabelsManagerOpen(false)}
        />
      )}

      {/* 编辑初始化导航 URL 覆盖 */}
      <Dialog open={urlDialogOpen} onOpenChange={setUrlDialogOpen}>
        <DialogContent style={{ maxWidth: 420 }}>
          <DialogHeader><DialogTitle>覆盖初始化导航 URL</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <Input
              label="用例 URL（可空）"
              placeholder="https://example.com/login"
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              autoFocus
            />
            <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              留空清除覆盖，回放 URL 将回退到分组默认域名 / 项目域名。
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setUrlDialogOpen(false)}>取消</Button>
            <Button
              disabled={urlSaving}
              onClick={() => {
                setUrlSaving(true);
                api.cases
                  .patch(id!, { url: urlDraft.trim() ? urlDraft.trim() : null })
                  .then(() => {
                    qc.invalidateQueries({ queryKey: ['case', id] });
                    toast('已保存', 'success');
                    setUrlDialogOpen(false);
                  })
                  .catch((e: Error) => toast(e.message, 'error'))
                  .finally(() => setUrlSaving(false));
              }}
            >
              {urlSaving ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 录制前确认：是否先回放前置步骤 */}
      <Dialog open={!!confirmResume} onOpenChange={(o) => !o && setConfirmResume(null)}>
        <DialogContent style={{ maxWidth: 420 }}>
          <DialogHeader><DialogTitle>录制前先回放前置步骤？</DialogTitle></DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
            选「先回放」时，录制器会先把当前步骤之前的步骤全部跑一遍（便于基于已有登录态继续）。
            选「不预览」则直接从该步骤开始录制，前置步骤不会回放。
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                if (!confirmResume) return;
                setResumeTarget(confirmResume);
                setMode('resume');
                setConfirmResume(null);
                toast('已选中从此处开始，前置步骤不会回放', 'info');
              }}
            >
              不预览
            </Button>
            <Button
              onClick={() => {
                if (!confirmResume) return;
                setResumeTarget(confirmResume);
                setMode('resume');
                setConfirmResume(null);
                toast('已选中，录制时会先回放前置步骤', 'info');
              }}
            >
              先回放
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除步骤确认:误删需重新录制或编辑回填,前端一律先弹再发请求 */}
      <Dialog open={!!confirmDeleteStep} onOpenChange={(o) => !o && setConfirmDeleteStep(null)}>
        <DialogContent style={{ maxWidth: 420 }}>
          <DialogHeader><DialogTitle>删除步骤</DialogTitle></DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
            确认删除第 {confirmDeleteStep?.order} 步「{confirmDeleteStep?.instruction}」？删除后需重新录制或编辑回填,不可恢复。
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDeleteStep(null)}>取消</Button>
            <Button
              variant="danger"
              disabled={deleteStep.isPending}
              onClick={() => confirmDeleteStep && deleteStep.mutate(confirmDeleteStep.stepId)}
            >
              {deleteStep.isPending ? '删除中...' : '确认删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}