import { useEffect, useMemo, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { AssistantRuntimeProvider, useAui, useAuiState } from '@assistant-ui/react';
import { createPiHttpClient, usePiRuntime, type PiClientEvent } from '@assistant-ui/react-pi';
import SpaceThreadPane from './SpaceThreadPane';
import StagePanel from './StagePanel';
import { useSpaceEventsStore } from './spaceEventsStore';

interface Props {
  threadId: string;
  /** 来自上一跳 location.state 的首条 prompt;非空时 mount 后自动发给 AI（仅一次）。 */
  initialMessage?: string;
}

/**
 * 空间助手运行时容器:client 指向 /api/assistant(与 /api/pi 同契约的子集);
 * subscribe 分流:自定义事件(confirm_request/stage/announce)先进空间事件 store,
 * 再原样交给 runtime(pi 契约事件 runtime 自己处理,自定义事件其 reducer 忽略)。
 * 父级以 key=threadId 挂载本组件:切换线程即重挂载出全新 runtime。
 */
export default function SpaceWorkspace({ threadId, initialMessage }: Props) {
  const { projectId, versionId } = useParams<{ projectId: string; versionId: string }>();
  const client = useMemo(() => {
    const base = createPiHttpClient({ baseUrl: '/api/assistant' });
    const ingest = useSpaceEventsStore.getState().ingest;
    return {
      ...base,
      subscribe: (tid: string, listener: (e: PiClientEvent) => void, options?: { includeSnapshot?: boolean }) =>
        base.subscribe(
          tid,
          (e) => {
            ingest(e as unknown as Record<string, unknown>);
            listener(e);
          },
          options,
        ),
    };
  }, []);
  // 线程切换(mount)时清掉上一线程的确认卡与舞台状态
  useEffect(() => {
    const store = useSpaceEventsStore.getState();
    store.reset();
    // 线程 id 存 store:StagePanel 订阅同一份 state 拉暂存列表,spaceEventsStore 用于 SSE stage 事件 upsert
    store.setCurrentThreadId(threadId);
    return () => {
      useSpaceEventsStore.getState().setCurrentThreadId('');
    };
  }, [threadId]);
  const runtime = usePiRuntime({ client, initialThreadId: threadId });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 min-w-0 min-h-0" style={{ borderRight: '1px solid var(--border)' }}>
          <SpaceThreadPane threadId={threadId} />
        </div>
        <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
          <StagePanel projectId={projectId!} versionId={versionId!} />
        </div>
      </div>
      {/* aui 必须在 AssistantRuntimeProvider 内使用;首条 prompt 在此层挂载后注入。 */}
      {initialMessage && <InitialMessageInjector threadId={threadId} text={initialMessage} />}
    </AssistantRuntimeProvider>
  );
}

/** 远程线程绑定 + 历史加载完成后再 append;StrictMode 双触发由 ref 守护。
 *  来自 requirement 级工作台 ThreadPane 的同款逻辑,见 apps/web/src/features/ai-workspace/ThreadPane.tsx。 */
function InitialMessageInjector({ threadId, text }: { threadId: string; text: string }) {
  const aui = useAui();
  const remoteId = useAuiState((s) => s.optional.threadListItem?.remoteId);
  const isLoading = useAuiState((s) => s.optional.thread?.isLoading ?? false);
  const sentRef = useRef(false);
  const textRef = useRef(text);
  textRef.current = text;
  const doneRef = useRef(false);
  useEffect(() => {
    if (doneRef.current) return;
    if (sentRef.current) return;
    if (remoteId !== threadId || isLoading) return;
    sentRef.current = true;
    aui.thread.append(textRef.current);
    // 等当前 tick 让 append 落乐观消息后再解除 done,避免 ref 提前清掉
    queueMicrotask(() => { doneRef.current = true; });
    // exhaustive-deps 故意忽略:仅依赖 threadId/remoteId/isLoading 三态;text 走 textRef 始终取最新
  }, [threadId, remoteId, isLoading]);
  return null;
}
