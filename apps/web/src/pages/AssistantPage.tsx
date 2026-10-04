import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import {
  PageShell,
  PageShellActions,
  PageShellContent,
  PageShellDescription,
  PageShellHeader,
  PageShellTitle,
} from '../components/layout/PageShell';
import SpaceWorkspace from '../features/space-assistant/SpaceWorkspace';

/**
 * 版本空间 AI 助手(AI-First 主入口):进入版本空间落地即对话。
 * 页面层只负责线程管理(最近线程下拉 + 新建 + 初始化错误引导);
 * 对话与舞台由 SpaceWorkspace 渲染(Task 3 接入)。
 */
export default function AssistantPage() {
  const { versionId } = useParams<{ projectId: string; versionId: string }>();
  const navigate = useNavigate();
  const threadsQ = useQuery({
    queryKey: ['assistant-threads', versionId],
    queryFn: () => api.assistant.listThreads(versionId!),
    enabled: !!versionId,
  });
  const [threadId, setThreadId] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  // 非阻断警告(repo 不可用等,后端经快照 lastError 透出):对话仍可用
  const [warning, setWarning] = useState<string | null>(null);

  // 首次进入自动选中最近一条线程;无线程时保持空态
  useEffect(() => {
    if (threadId) return;
    const first = threadsQ.data?.[0];
    if (first) setThreadId(first.id);
  }, [threadsQ.data, threadId]);

  const create = useMutation({
    mutationFn: () => api.assistant.createThread(versionId!),
    onSuccess: (snap) => {
      setInitError(null);
      setWarning(snap.lastError ?? null);
      setThreadId(snap.metadata.id);
      void threadsQ.refetch();
    },
    onError: (e: Error) => setInitError(e.message),
  });

  const llmMissing = initError?.includes('LLM 未配置') ?? false;
  const threads = threadsQ.data ?? [];

  return (
    <PageShell contained>
      <PageShellHeader>
        <PageShellTitle>AI 助手</PageShellTitle>
        <PageShellActions>
          <select
            className="input-base input-sm max-w-[280px]"
            value={threadId ?? ''}
            onChange={(e) => {
              setInitError(null);
              setWarning(null);
              setThreadId(e.target.value || null);
            }}
            aria-label="历史对话"
          >
            {!threadId && <option value="">开始新对话</option>}
            {threadId && !threads.some((t) => t.id === threadId) && (
              <option value={threadId}>新对话</option>
            )}
            {threads.map((t) => (
              <option key={t.id} value={t.id}>{t.title || '新对话'}</option>
            ))}
          </select>
          <Button size="sm" disabled={create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? '创建中…' : '新对话'}
          </Button>
        </PageShellActions>
        <PageShellDescription>用一句话管理用例、环境与计划;意图不明时 AI 会主动追问</PageShellDescription>
      </PageShellHeader>

      <PageShellContent className="min-h-0">
        {initError ? (
          <div
            className="rounded-[var(--radius-sm)] px-4 py-3 text-[13px]"
            style={{ border: '1px solid var(--destructive)', color: 'var(--destructive)' }}
          >
            {initError}
            <div className="flex gap-2 mt-2">
              {llmMissing && <Button size="sm" onClick={() => navigate('/settings')}>去设置模型</Button>}
              <Button size="sm" variant="ghost" disabled={create.isPending} onClick={() => create.mutate()}>重试</Button>
            </div>
          </div>
        ) : (
          <>
            {warning && (
              <div
                className="rounded-[var(--radius-sm)] px-4 py-2.5 text-[12px] shrink-0"
                style={{ border: '1px solid var(--warning-soft-border)', color: 'var(--warning)', background: 'var(--warning-soft)' }}
              >
                {warning}
              </div>
            )}
            {threadId ? (
              <SpaceWorkspace key={threadId} threadId={threadId} />
            ) : (
              <EmptyState
                icon="message"
                title="开始与 AI 的第一次对话"
                description="试试「看看现在有哪些环境」或「帮我建三条登录用例」。"
              />
            )}
          </>
        )}
      </PageShellContent>
    </PageShell>
  );
}
