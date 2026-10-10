import {
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type ReasoningMessagePartProps,
  type TextMessagePartProps,
  type ToolCallMessagePartProps,
} from '@assistant-ui/react';
import ConfirmCard from './ConfirmCard';
import Icon, { type IconName } from '../../components/Icon';
import Markdown from '../../components/ui/Markdown';
import { useSpaceEventsStore } from './spaceEventsStore';

/**
 * 空间助手对话流:只渲染 pi 契约的结构原语,运行时由 SpaceWorkspace 的
 * AssistantRuntimeProvider 提供。composer 上方为确认卡(confirm_request 事件驱动)。
 * 文本 part 走 markdown 渲染;工具调用渲染为图标 chip(进行中/完成/失败三态)。
 */
export default function SpaceThreadPane({ threadId }: { threadId: string }) {
  return (
    <div className="flex flex-col h-full">
      <ThreadPrimitive.Root className="flex flex-col h-full">
        <ThreadPrimitive.Viewport className="flex-1 min-h-0 overflow-y-auto px-4 py-5">
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          {/* 运行期常驻指示:工具间隙/模型静默期没有任何可见输出,靠底部三点动效提示会话仍在跑,避免"卡死"错觉 */}
          <ThreadPrimitive.If running>
            <RunningIndicator />
          </ThreadPrimitive.If>
        </ThreadPrimitive.Viewport>
        <ThreadPrimitive.ViewportFooter className="border-t p-3" style={{ borderColor: 'var(--border)' }}>
          <VerifyProgressCard />
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
                className="press shrink-0 rounded-md px-3 py-2 text-[13px] text-white"
                style={{ background: 'var(--primary)' }}
              >
                发送
              </ComposerPrimitive.Send>
            </ThreadPrimitive.If>
            <ThreadPrimitive.If running>
              <ComposerPrimitive.Cancel
                className="press shrink-0 rounded-md px-3 py-2 text-[13px] text-white"
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
    <div className="fade-up mb-4 flex justify-end">
      <div
        className="max-w-[85%] whitespace-pre-wrap rounded-[var(--radius-md)] rounded-br-sm px-3.5 py-2 text-[13px] leading-relaxed"
        style={{ background: 'var(--primary-soft)', color: 'var(--foreground)' }}
      >
        <MessagePrimitive.Parts />
      </div>
    </div>
  );
}

function AssistantMessage() {
  return (
    <div className="fade-up mb-4 text-[13px]" style={{ color: 'var(--foreground)' }}>
      <MessagePrimitive.Parts
        components={{
          Text: TextPart,
          Reasoning: ThinkingPart,
          tools: { Fallback: ToolActivity },
        }}
      />
      {/* LLM 失败(stopReason=error):错误原文必须可见,否则用户看到的是零反馈 */}
      <ErrorPrimitive.Message
        className="mt-1.5 block w-fit max-w-full break-all rounded-[var(--radius-md)] px-2.5 py-1.5 text-[12px]"
        style={{
          background: 'var(--destructive-soft)',
          border: '1px solid var(--destructive-soft-border)',
          color: 'var(--destructive)',
        }}
      />
    </div>
  );
}

/** 运行指示:running=true 期间常驻消息列表底部(thinking-dot 三点动效,与思考中段同一视觉语言)。 */
function RunningIndicator() {
  return (
    <div className="mb-4 inline-flex items-center gap-1 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
      正在运行
      <span className="inline-flex items-center gap-0.5">
        <span className="thinking-dot" />
        <span className="thinking-dot" />
        <span className="thinking-dot" />
      </span>
    </div>
  );
}

/** 文本 part → markdown 渲染（流式期间随文本增量重解析，量级可忽略）。 */
function TextPart({ text }: TextMessagePartProps) {
  return <Markdown text={text} />;
}

/** thinking 段:进行中给"思考中…"三点动画,完成后收起(推理文本不常驻聊天区)。 */
function ThinkingPart({ status }: ReasoningMessagePartProps) {
  if (status.type !== 'running') return null;
  return (
    <div className="mb-2 inline-flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
      思考中
      <span className="inline-flex items-center gap-0.5">
        <span className="thinking-dot" />
        <span className="thinking-dot" />
        <span className="thinking-dot" />
      </span>
    </div>
  );
}

/** 空间工具 → chip 文案与图标;未知工具返回 null 不渲染。 */
function toolMeta(toolName: string, args: unknown): { icon: IconName; label: string; summary: string } | null {
  const a = (args ?? {}) as Record<string, unknown>;
  const action = typeof a.action === 'string' ? a.action : '';
  if (toolName === 'inspect_page') return { icon: 'search', label: '抓取页面', summary: typeof a.url === 'string' ? a.url : '' };
  if (toolName === 'announce_plan') return { icon: 'flag', label: '生成计划', summary: typeof a.summary === 'string' ? a.summary : '' };
  if (toolName === 'manage_cases') return { icon: 'beaker', label: '用例管理', summary: action };
  if (toolName === 'manage_scenarios') return { icon: 'layers', label: '场景管理', summary: action };
  if (toolName === 'manage_environments') return { icon: 'globe', label: '环境管理', summary: action };
  if (toolName === 'manage_plans') return { icon: 'listChecks', label: '计划管理', summary: action };
  if (toolName === 'verify_case') return { icon: 'beaker', label: '实测验证', summary: typeof a.caseId === 'string' ? a.caseId.slice(0, 8) : '' };
  if (toolName.startsWith('repo_')) {
    return { icon: 'code', label: '读取仓库', summary: typeof a.path === 'string' ? a.path : (typeof a.command === 'string' ? a.command : '') };
  }
  return null;
}

/** verify_case 实时进度卡：verify_progress SSE 事件驱动，逐条渲染步骤状态（运行中/通过/失败）。 */
function VerifyProgressCard() {
  const vp = useSpaceEventsStore((s) => s.verifyProgress);
  if (!vp) return null;
  const done = vp.result !== null;
  return (
    <div
      className="fade-up mb-2 rounded-[var(--radius-md)] px-3 py-2 text-[12px]"
      style={{ background: 'var(--muted)', border: '1px solid var(--border)' }}
    >
      <div className="mb-1.5 flex items-center gap-1.5" style={{ color: 'var(--muted-foreground)' }}>
        <Icon name="beaker" size={12} style={{ flexShrink: 0 }} />
        <span className="truncate">
          实测验证（{vp.steps.filter((s) => s.status !== 'running').length}/{vp.total} 步
          {vp.targetUrl ? ` · ${vp.targetUrl}` : ''}）
        </span>
        {vp.loginCache === 'hit' ? (
          <span style={{ color: 'var(--success)', flexShrink: 0 }}>登录缓存命中{vp.loginUser ? `（${vp.loginUser}）` : ''}</span>
        ) : vp.loginCache === 'miss' ? (
          <span style={{ flexShrink: 0 }}>{vp.loginUser ? `登录缓存未命中（${vp.loginUser}）` : '未配置登录凭据'}</span>
        ) : null}
        {vp.stagedOps > 0 ? <span style={{ flexShrink: 0 }}>基于暂存（{vp.stagedOps} 项修改）</span> : null}
        {done ? (
          <Icon
            name={vp.result === 'passed' ? 'check' : 'close'}
            size={12}
            style={{ color: vp.result === 'passed' ? 'var(--success)' : 'var(--destructive)', flexShrink: 0 }}
          />
        ) : (
          <Icon name="loader" size={12} className="animate-spin" style={{ color: 'var(--primary)', flexShrink: 0 }} />
        )}
        {done && vp.cacheSaved ? <span style={{ flexShrink: 0 }}>· 已回写登录缓存</span> : null}
      </div>
      <div className="flex flex-col gap-0.5">
        {vp.steps.map((s) => (
          <div key={s.order} className="flex items-start gap-1.5" style={{ color: 'var(--muted-foreground)' }}>
            <Icon
              name={s.status === 'running' ? 'loader' : s.status === 'passed' ? 'check' : 'close'}
              size={11}
              className={s.status === 'running' ? 'animate-spin' : ''}
              style={{
                color:
                  s.status === 'running'
                    ? 'var(--primary)'
                    : s.status === 'passed'
                      ? 'var(--success)'
                      : 'var(--destructive)',
                flexShrink: 0,
                marginTop: 2,
              }}
            />
            <span className="min-w-0 break-all">
              第 {s.order} 步{s.brief ? `：${s.brief}` : ''}
              {s.status === 'failed' && s.reason ? ` — ${s.reason}` : ''}
              {s.durationMs != null && s.status !== 'running' ? `（${(s.durationMs / 1000).toFixed(1)}s）` : ''}
              {s.login === 'logged-in' ? ' · 已登录' : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 工具调用 chip:进行中(loader 旋转)/完成(check)/失败(✗ destructive),让操作过程有渐进反馈。 */
function ToolActivity(part: ToolCallMessagePartProps) {
  const meta = toolMeta(part.toolName, part.args);
  if (!meta) return null;
  const running = part.status.type === 'running';
  const statusColor = running ? 'var(--primary)' : part.isError ? 'var(--destructive)' : 'var(--success)';
  return (
    <div
      className="mb-1.5 flex w-fit max-w-full items-center gap-1.5 rounded-[var(--radius-md)] px-2 py-1 text-[12px]"
      style={{ background: 'var(--muted)', border: '1px solid var(--border)', color: 'var(--muted-foreground)' }}
    >
      <Icon name={meta.icon} size={12} style={{ flexShrink: 0 }} />
      <span className="truncate">
        {meta.label}
        {meta.summary ? `：${meta.summary}` : ''}
      </span>
      {running ? (
        <Icon name="loader" size={12} className="animate-spin" style={{ color: statusColor, flexShrink: 0 }} />
      ) : (
        <Icon name={part.isError ? 'close' : 'check'} size={12} style={{ color: statusColor, flexShrink: 0 }} />
      )}
    </div>
  );
}
