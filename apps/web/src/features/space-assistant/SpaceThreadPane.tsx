import {
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type ReasoningMessagePartProps,
  type ToolCallMessagePartProps,
} from '@assistant-ui/react';
import ConfirmCard from './ConfirmCard';

/**
 * 空间助手对话流:只渲染 pi 契约的结构原语,运行时由 SpaceWorkspace 的
 * AssistantRuntimeProvider 提供。composer 上方为确认卡(confirm_request 事件驱动)。
 */
export default function SpaceThreadPane({ threadId }: { threadId: string }) {
  return (
    <div className="flex flex-col h-full">
      <ThreadPrimitive.Root className="flex flex-col h-full">
        <ThreadPrimitive.Viewport className="flex-1 min-h-0 overflow-y-auto p-4">
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        </ThreadPrimitive.Viewport>
        <ThreadPrimitive.ViewportFooter className="border-t p-3" style={{ borderColor: 'var(--border)' }}>
          <ConfirmCard threadId={threadId} />
          <ComposerPrimitive.Root className="flex items-end gap-2">
            <ComposerPrimitive.Input
              minRows={1}
              maxRows={6}
              placeholder="让 AI 查环境、建用例、排计划…"
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
    </div>
  );
}

/** thinking 段:进行中给"思考中…"心跳提示,完成后收起(推理文本不常驻聊天区)。 */
function ThinkingPart({ status }: ReasoningMessagePartProps) {
  if (status.type !== 'running') return null;
  return (
    <div className="mb-1 animate-pulse text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
      思考中…
    </div>
  );
}

/** 空间工具 → 活动行文案;未知工具返回 null 不渲染。 */
function toolMeta(toolName: string, args: unknown): { icon: string; label: string; summary: string } | null {
  const a = (args ?? {}) as Record<string, unknown>;
  const action = typeof a.action === 'string' ? a.action : '';
  if (toolName === 'inspect_page') return { icon: '🔍', label: '抓取页面', summary: typeof a.url === 'string' ? a.url : '' };
  if (toolName === 'announce_plan') return { icon: '📣', label: '生成计划', summary: typeof a.summary === 'string' ? a.summary : '' };
  if (toolName === 'manage_cases') return { icon: '📝', label: '用例管理', summary: action };
  if (toolName === 'manage_scenarios') return { icon: '🗂', label: '场景管理', summary: action };
  if (toolName === 'manage_environments') return { icon: '🌐', label: '环境管理', summary: action };
  if (toolName === 'manage_plans') return { icon: '📋', label: '计划管理', summary: action };
  if (toolName.startsWith('repo_')) {
    return { icon: '📂', label: '读取仓库', summary: typeof a.path === 'string' ? a.path : (typeof a.command === 'string' ? a.command : '') };
  }
  return null;
}

/** 工具调用活动行:进行中/完成/失败三态,让操作过程有渐进反馈。 */
function ToolActivity(part: ToolCallMessagePartProps) {
  const meta = toolMeta(part.toolName, part.args);
  if (!meta) return null;
  const running = part.status.type === 'running';
  return (
    <div className="mb-1 flex min-w-0 items-center gap-1.5 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
      <span>{meta.icon}</span>
      <span className="truncate">
        {meta.label}
        {meta.summary ? `：${meta.summary}` : ''}
      </span>
      {running ? (
        <span className="animate-pulse">进行中…</span>
      ) : (
        <span className="shrink-0" style={{ color: part.isError ? 'var(--destructive)' : 'var(--primary)' }}>
          {part.isError ? '✗ 失败' : '✓'}
        </span>
      )}
    </div>
  );
}
