import { useEffect, useMemo, useRef } from 'react';
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  type ReasoningMessagePartProps,
  type ToolCallMessagePartProps,
} from '@assistant-ui/react';
import { usePiRuntime, createPiHttpClient, type PiSendMessageInput } from '@assistant-ui/react-pi';
import type { ContextMode } from './ContextModeSelector';

interface Props {
  requirementId: string;
  threadId: string;
  /** 来自上一跳 location.state 的首条需求文本；非空时挂载后自动发给 AI（仅一次）。 */
  initialMessage?: string;
  /** 父页面持有的上下文模式，会随每条 aui.thread.append 透传到后端 metadata.contextMode。 */
  contextMode: ContextMode;
}

/**
 * Pi agent thread pane. The runtime connects to `/api/pi/*` and `ThreadPrimitive`
 * renders the messages. We render only the structural primitives — the Pi
 * runtime wires thread state from `usePiRuntime`.
 */
export default function ThreadPane({ threadId, initialMessage, contextMode }: Props) {
  // contextMode 透传到每条 sendMessage：aui.thread.append 走 ThreadController.sendMessage
  // → client.sendMessage → POST /api/pi/threads/:id/messages，
  // 后端 router 把 metadata.contextMode 落到 workspace doc + 影响 system prompt 注入。
  // react-pi 默认 sendMessage 把 input 包成 { input }，会丢掉任何附在 input 上的 metadata；
  // 用 wrapper client 在 sendMessage 路径直接 fetch，把 metadata 提到 body 顶层（与 router 期望的
  // shape 对齐）。contextModeRef 保证每条消息发出去时用的是当时选中的 mode，不是 mount 时的快照。
  const contextModeRef = useRef(contextMode);
  contextModeRef.current = contextMode;
  const client = useMemo(() => {
    const base = createPiHttpClient();
    return {
      ...base,
      sendMessage: async (threadId: string, input: PiSendMessageInput) => {
        await fetch(`/api/pi/threads/${encodeURIComponent(threadId)}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input: { content: input.content, ...(input.attachments ? { attachments: input.attachments } : {}) },
            metadata: { contextMode: contextModeRef.current },
          }),
        }).then((r) => {
          if (!r.ok && r.status !== 204) throw new Error(`HTTP ${r.status}`);
        });
      },
    };
  }, []);
  const runtime = usePiRuntime({ client, initialThreadId: threadId });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPaneBody threadId={threadId} initialMessage={initialMessage} />
    </AssistantRuntimeProvider>
  );
}

function ThreadPaneBody({ threadId, initialMessage }: { threadId: string; initialMessage?: string }) {
  const aui = useAui();
  // usePiRuntime 基于 useRemoteThreadListRuntime，初始化是异步的：mount 时主线程
  // 还是本地临时"新线程"，此刻 append 的消息会落在临时线程里、随后被丢弃。
  // 必须等主线程绑定到目标远端线程且历史加载完成后再发送。
  const remoteId = useAuiState((s) => s.optional.threadListItem?.remoteId);
  const isLoading = useAuiState((s) => s.optional.thread?.isLoading ?? false);
  const sentRef = useRef(false);
  useEffect(() => {
    if (!initialMessage || sentRef.current) return;
    if (remoteId !== threadId || isLoading) return;
    // aui.thread.append 走 runtime 的 _store.onNew → controller.sendMessage：
    // 会落乐观用户消息、把 runStatus 置为 running、调 client.sendMessage
    // （命中后端 POST /api/pi/threads/:id/messages）。
    // StrictMode 双触发：ref 守护。
    sentRef.current = true;
    aui.thread.append(initialMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessage, threadId, remoteId, isLoading]);

  return (
    <div className="flex flex-col h-full">
      <ThreadPrimitive.Root className="flex flex-col h-full">
        <ThreadPrimitive.Viewport className="flex-1 min-h-0 overflow-y-auto p-4">
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        </ThreadPrimitive.Viewport>
        <ThreadPrimitive.ViewportFooter className="border-t p-3" style={{ borderColor: 'var(--border)' }}>
          <ComposerPrimitive.Root className="flex items-end gap-2">
            <ComposerPrimitive.Input
              minRows={1}
              maxRows={6}
              placeholder="描述你的需求，AI 将生成测试用例…"
              className="flex-1 resize-none rounded-md border px-3 py-2 text-[13px] outline-none"
              style={{ borderColor: 'var(--border)', background: 'var(--popover)', color: 'var(--foreground)' }}
            />
            <ThreadPrimitive.If running={false}>
              <ComposerPrimitive.Send
                className="shrink-0 rounded-md px-3 py-2 text-[13px] text-white"
                style={{ background: 'var(--primary)' }}
              >
                发送
              </ComposerPrimitive.Send>
            </ThreadPrimitive.If>
            <ThreadPrimitive.If running>
              <ComposerPrimitive.Cancel
                className="shrink-0 rounded-md px-3 py-2 text-[13px] text-white"
                style={{ background: 'var(--destructive)' }}
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
        style={{ background: 'var(--primary-soft)', color: 'var(--foreground)' }}
      >
        <MessagePrimitive.Parts />
      </div>
    </div>
  );
}

function AssistantMessage() {
  return (
    <div className="mb-3 text-[13px] whitespace-pre-wrap" style={{ color: 'var(--foreground)' }}>
      <MessagePrimitive.Parts
        components={{
          Reasoning: ThinkingPart,
          tools: { Fallback: ToolActivity },
        }}
      />
      {/* LLM 失败(stopReason=error):错误原文必须可见,否则用户看到的是零反馈 */}
      <ErrorPrimitive.Message
        className="mt-1.5 block w-fit max-w-full break-all rounded-lg px-2.5 py-1.5 text-[12px]"
        style={{
          background: 'var(--destructive-soft)',
          border: '1px solid var(--destructive-soft-border)',
          color: 'var(--destructive)',
        }}
      />
    </div>
  );
}

/** thinking 段：进行中给"思考中…"心跳提示，完成后收起（推理文本不常驻聊天区）。 */
function ThinkingPart({ status }: ReasoningMessagePartProps) {
  if (status.type !== 'running') return null;
  return (
    <div className="mb-1 animate-pulse text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
      思考中…
    </div>
  );
}

const TOOL_META: Record<string, { icon: string; label: string }> = {
  inspect_page: { icon: '🌐', label: '抓取页面实际元素' },
  announce_plan: { icon: '📋', label: '制定生成计划' },
  upsert_scenario: { icon: '🗂', label: '暂存场景' },
  upsert_case: { icon: '📝', label: '暂存测试用例' },
  remove_item: { icon: '🗑', label: '移除条目' },
};

function toolArgSummary(toolName: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case 'inspect_page': return typeof a.url === 'string' ? a.url : '';
    case 'announce_plan': return `${a.scenarios ?? '—'} 个场景 · ${a.cases ?? '—'} 条用例`;
    case 'upsert_scenario':
    case 'upsert_case': {
      const t = typeof a.title === 'string' ? a.title : (typeof a.id === 'string' ? a.id : '');
      return t;
    }
    case 'remove_item': return `${a.kind === 'scenario' ? '场景' : '用例'} ${typeof a.id === 'string' ? a.id : ''}`;
    default: return '';
  }
}

/** 工具调用活动行：进行中/完成/失败三态，让生成过程有渐进反馈而不是只有 spinner。 */
function ToolActivity(part: ToolCallMessagePartProps) {
  const meta = TOOL_META[part.toolName];
  if (!meta) return null;
  const running = part.status.type === 'running';
  const summary = toolArgSummary(part.toolName, part.args);
  // inspect_page 完成后从结果清单里数出元素个数，作为最有用的完成反馈
  let done: string | null = null;
  if (!running) {
    if (part.isError) done = '✗ 失败';
    else if (part.toolName === 'inspect_page' && typeof part.result === 'string') {
      const n = part.result.split('\n').filter((l) => l.startsWith('- ')).length;
      done = n > 0 ? `✓ 已获取 ${n} 个元素` : '✓';
    } else done = '✓';
  }
  return (
    <div className="mb-1 flex min-w-0 items-center gap-1.5 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
      <span>{meta.icon}</span>
      <span className="truncate">
        {meta.label}
        {summary ? `：${summary}` : ''}
      </span>
      {running ? (
        <span className="animate-pulse">进行中…</span>
      ) : (
        <span className="shrink-0" style={{ color: part.isError ? 'var(--destructive)' : 'var(--primary)' }}>
          {done}
        </span>
      )}
    </div>
  );
}
