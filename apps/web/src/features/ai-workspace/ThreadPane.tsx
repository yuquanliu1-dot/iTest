import { useEffect, useMemo, useRef } from 'react';
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
} from '@assistant-ui/react';
import { usePiRuntime, createPiHttpClient } from '@assistant-ui/react-pi';

interface Props {
  requirementId: string;
  threadId: string;
  /** 来自上一跳 location.state 的首条需求文本；非空时挂载后自动发给 AI（仅一次）。 */
  initialMessage?: string;
}

/**
 * Pi agent thread pane. The runtime connects to `/api/pi/*` and `ThreadPrimitive`
 * renders the messages. We render only the structural primitives — the Pi
 * runtime wires thread state from `usePiRuntime`.
 */
export default function ThreadPane({ threadId, initialMessage }: Props) {
  const client = useMemo(() => createPiHttpClient(), []);
  const runtime = usePiRuntime({ client, initialThreadId: threadId });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPaneBody initialMessage={initialMessage} />
    </AssistantRuntimeProvider>
  );
}

function ThreadPaneBody({ initialMessage }: { initialMessage?: string }) {
  const aui = useAui();
  const sentRef = useRef(false);
  useEffect(() => {
    if (!initialMessage) return;
    if (sentRef.current) return;
    // aui.thread.append 走 runtime 的 _store.onNew → controller.sendMessage：
    // 会落乐观用户消息、把 runStatus 置为 running、调 client.sendMessage
    // （命中后端 POST /api/pi/threads/:id/messages）。
    // StrictMode 双触发：ref 守护 + 仅依赖 initialMessage。
    sentRef.current = true;
    // append 同步执行；不弹 toast：用户在聊天输入框，下一次手动发送仍可触发
    aui.thread.append(initialMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessage, aui.thread]);

  return (
    <div className="flex flex-col h-full">
      <ThreadPrimitive.Root className="flex flex-col h-full">
        <ThreadPrimitive.Viewport className="flex-1 min-h-0 overflow-y-auto p-4">
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        </ThreadPrimitive.Viewport>
        <ThreadPrimitive.ViewportFooter className="border-t p-3" style={{ borderColor: 'var(--color-border)' }}>
          <ComposerPrimitive.Root className="flex items-end gap-2">
            <ComposerPrimitive.Input
              minRows={1}
              maxRows={6}
              placeholder="描述你的需求，AI 将生成测试用例…"
              className="flex-1 resize-none rounded-md border px-3 py-2 text-[13px] outline-none"
              style={{ borderColor: 'var(--color-border)', background: 'transparent', color: 'var(--color-foreground)' }}
            />
            <ThreadPrimitive.If running={false}>
              <ComposerPrimitive.Send
                className="shrink-0 rounded-md px-3 py-2 text-[13px] text-white"
                style={{ background: 'var(--color-primary, #6366f1)' }}
              >
                发送
              </ComposerPrimitive.Send>
            </ThreadPrimitive.If>
            <ThreadPrimitive.If running>
              <ComposerPrimitive.Cancel
                className="shrink-0 rounded-md px-3 py-2 text-[13px] text-white"
                style={{ background: 'var(--color-danger, #ef4444)' }}
              >
                停止
              </ComposerPrimitive.Cancel>
            </ThreadPrimitive.If>
          </ComposerPrimitive.Root>
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Root>
    </div>
  );
}

function UserMessage() {
  return (
    <div className="flex justify-end mb-3">
      <div
        className="max-w-[85%] rounded-lg px-3 py-2 text-[13px] whitespace-pre-wrap"
        style={{ background: 'var(--color-primary-soft, #eef2ff)', color: 'var(--color-foreground)' }}
      >
        <MessagePrimitive.Parts />
      </div>
    </div>
  );
}

function AssistantMessage() {
  return (
    <div className="mb-3 text-[13px] whitespace-pre-wrap" style={{ color: 'var(--color-foreground)' }}>
      <MessagePrimitive.Parts />
    </div>
  );
}
