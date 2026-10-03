import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import Button from '../components/ui/Button';
import ThreadPane from '../features/ai-workspace/ThreadPane';
import WorkspacePanel from '../features/ai-workspace/WorkspacePanel';
import SaveDialog from '../features/ai-workspace/SaveDialog';
import type { ContextMode } from '../features/ai-workspace/ContextModeSelector';

interface SaveSelection {
  open: boolean;
  groupId?: string;
  scenarioIds: string[];
  caseIds: string[];
}

interface InitialMessageState {
  initialMessage?: string;
  requirement?: { requirementId: string; title: string; content: string };
}

export default function AiWorkspacePage() {
  const { projectId, id } = useParams<{ projectId: string; id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();

  const ensure = useMutation({
    mutationFn: () => api.aiWorkspace.ensureThread(id!),
  });
  useEffect(() => {
    if (!ensure.data && !ensure.isPending && !ensure.isError) ensure.mutate();
  }, [ensure]);
  const threadId = ensure.data?.threadId;

  // 上一跳 location.state 带来的首条需求文本；下传给 ThreadPane 走 aui.thread.append 自动发送。
  const state = (location.state ?? {}) as InitialMessageState;
  // 必须在清掉 location.state 前捕获进组件 state：ThreadPane 要等 ensure 拿到 threadId
  // 才挂载，届时 location.state 已被下面的 effect 清空，直接传 state.initialMessage 会丢。
  const [initialMessage] = useState(state.initialMessage);

  // mount 时立刻清掉 location.state（仅当非空时），避免用户从用例列表再点同一个
  // requirement 时又把 stale initialMessage 带回。
  useEffect(() => {
    if (!state.initialMessage) return;
    navigate(location.pathname, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [saveSelection, setSaveSelection] = useState<SaveSelection>({
    open: false,
    scenarioIds: [],
    caseIds: [],
  });

  const { data: groups = [] } = useQuery({
    queryKey: ['groups', projectId],
    queryFn: () => api.projects.groups(projectId!),
    enabled: !!projectId,
  });

  // contextMode 在此层共享给 WorkspacePanel（chip + selector）与 ThreadPane（任务16用）。
  // 初始值取 ai-workspace doc，切换时本地先更、再异步 POST 持久化。
  const { data: workspace } = useQuery({
    queryKey: ['ai-workspace', id],
    queryFn: () => api.aiWorkspace.getWorkspace(id!),
    enabled: !!id && !!threadId,
  });
  const [contextMode, setContextMode] = useState<ContextMode>(workspace?.contextMode ?? 'auto');
  const contextModeRef = useRef(contextMode);
  contextModeRef.current = contextMode;
  useEffect(() => {
    const serverMode = workspace?.contextMode;
    if (serverMode && serverMode !== contextModeRef.current) {
      setContextMode(serverMode);
    }
  }, [workspace?.contextMode]);
  const onContextModeChange = (m: ContextMode) => {
    setContextMode(m);
    if (id) void api.aiWorkspace.setContextMode(id, m);
  };

  const saveMutation = useMutation({
    mutationFn: (vars: { groupId: string; scenarioIds: string[]; caseIds: string[] }) =>
      api.aiWorkspace.save(id!, vars),
    onSuccess: (r) => {
      toast(`已保存 ${r.savedCases} 个用例`, 'success');
      qc.invalidateQueries({ queryKey: ['ai-workspace', id] });
      qc.invalidateQueries({ queryKey: ['cases'] });
      setSaveSelection({ open: false, scenarioIds: [], caseIds: [] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  if (!threadId) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)' }}>
        <Icon name="loader" size={16} className="animate-spin" />
        <span style={{ marginLeft: 8 }}>初始化会话…</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div
        className="flex items-center gap-3 px-5 py-3 shrink-0 fade-up"
        style={{ borderBottom: '1px solid var(--color-glass-border)' }}
      >
        <Button variant="ghost" size="sm" onClick={() => navigate(`/p/${projectId}/groups`)}>
          <Icon name="chevronLeft" size={12} />
          返回用例列表
        </Button>
        <h1 className="text-[15px] font-semibold">AI 创建用例</h1>
      </div>
      <div className="flex-1 min-h-0 flex">
        <div
          className="w-[420px] shrink-0 border-r"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <ThreadPane requirementId={id!} threadId={threadId} initialMessage={initialMessage} contextMode={contextMode} />
        </div>
        <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
          <WorkspacePanel
            requirementId={id!}
            projectId={projectId ?? ''}
            threadId={threadId}
            contextMode={contextMode}
            onContextModeChange={onContextModeChange}
            onOpenSave={(sel) => setSaveSelection({ open: true, ...sel })}
          />
        </div>
      </div>
      <SaveDialog
        open={saveSelection.open}
        onOpenChange={(o) => setSaveSelection((s) => ({ ...s, open: o }))}
        groups={groups}
        saving={saveMutation.isPending}
        onSave={(groupId) =>
          saveMutation.mutate({
            groupId,
            scenarioIds: saveSelection.scenarioIds,
            caseIds: saveSelection.caseIds,
          })
        }
      />
    </div>
  );
}
