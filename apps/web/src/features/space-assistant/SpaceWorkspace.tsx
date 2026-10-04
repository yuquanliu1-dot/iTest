import { useEffect, useMemo } from 'react';
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { createPiHttpClient, usePiRuntime, type PiClientEvent } from '@assistant-ui/react-pi';
import SpaceThreadPane from './SpaceThreadPane';
import { useSpaceEventsStore } from './spaceEventsStore';

interface Props {
  threadId: string;
}

/**
 * 空间助手运行时容器:client 指向 /api/assistant(与 /api/pi 同契约的子集);
 * subscribe 分流:自定义事件(confirm_request/stage/announce)先进空间事件 store,
 * 再原样交给 runtime(pi 契约事件 runtime 自己处理,自定义事件其 reducer 忽略)。
 * 父级以 key=threadId 挂载本组件:切换线程即重挂载出全新 runtime。
 */
export default function SpaceWorkspace({ threadId }: Props) {
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
    useSpaceEventsStore.getState().reset();
  }, [threadId]);
  const runtime = usePiRuntime({ client, initialThreadId: threadId });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 min-w-0 min-h-0" style={{ borderRight: '1px solid var(--border)' }}>
          <SpaceThreadPane threadId={threadId} />
        </div>
        <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
          {/* 舞台区(Task 5 接入 StagePanel) */}
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}
