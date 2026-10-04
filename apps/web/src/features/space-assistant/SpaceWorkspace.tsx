import { useMemo } from 'react';
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { createPiHttpClient, usePiRuntime } from '@assistant-ui/react-pi';
import SpaceThreadPane from './SpaceThreadPane';

interface Props {
  threadId: string;
}

/**
 * 空间助手运行时容器:client 指向 /api/assistant(与 /api/pi 同契约的子集),
 * AssistantRuntimeProvider 包住对话流与舞台(Task 5),两栏共享 aui 上下文。
 * 父级以 key=threadId 挂载本组件:切换线程即重挂载出全新 runtime。
 */
export default function SpaceWorkspace({ threadId }: Props) {
  const client = useMemo(() => createPiHttpClient({ baseUrl: '/api/assistant' }), []);
  const runtime = usePiRuntime({ client, initialThreadId: threadId });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 min-w-0 min-h-0" style={{ borderRight: '1px solid var(--border)' }}>
          <SpaceThreadPane />
        </div>
        <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
          {/* 舞台区(Task 5 接入 StagePanel) */}
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}
