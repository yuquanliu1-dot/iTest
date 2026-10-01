import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import ThreadPane from '../features/ai-workspace/ThreadPane';
import WorkspacePanel from '../features/ai-workspace/WorkspacePanel';
import SaveDialog from '../features/ai-workspace/SaveDialog';

interface SaveSelection {
  open: boolean;
  groupId?: string;
  scenarioIds: string[];
  caseIds: string[];
}

export default function AiWorkspacePage() {
  const { projectId, id } = useParams<{ projectId: string; id: string }>();
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();

  const ensure = useMutation({
    mutationFn: () => api.aiWorkspace.ensureThread(id!),
  });
  useEffect(() => {
    if (!ensure.data && !ensure.isPending && !ensure.isError) ensure.mutate();
  }, [ensure]);
  const threadId = ensure.data?.threadId;

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

  const saveMutation = useMutation({
    mutationFn: (vars: { groupId: string; scenarioIds: string[]; caseIds: string[] }) =>
      api.aiWorkspace.save(id!, vars),
    onSuccess: (r) => {
      toast(`已保存 ${r.savedCases} 个用例`, 'success');
      qc.invalidateQueries({ queryKey: ['ai-workspace', id] });
      qc.invalidateQueries({ queryKey: ['requirements', projectId] });
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
        className="flex items-center gap-3 px-5 py-3 shrink-0"
        style={{ borderBottom: '1px solid var(--color-glass-border)' }}
      >
        <button
          onClick={() => navigate(`/p/${projectId}/requirements/${id}`)}
          className="flex items-center gap-1 text-[12px]"
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--color-foreground-muted)',
          }}
        >
          <Icon name="chevronLeft" size={12} />
          返回需求详情
        </button>
        <h1 className="text-[15px] font-semibold">AI 创建用例</h1>
      </div>
      <div className="flex-1 min-h-0 flex">
        <div
          className="w-[420px] shrink-0 border-r"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <ThreadPane requirementId={id!} threadId={threadId} />
        </div>
        <div className="flex-1 min-w-0">
          <WorkspacePanel
            requirementId={id!}
            threadId={threadId}
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