import {
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  type ReasoningMessagePartProps,
  type TextMessagePartProps,
  type ToolCallMessagePartProps,
} from '@assistant-ui/react';
import { useTranslation } from 'react-i18next';
import ConfirmCard from './ConfirmCard';
import FeedbackActions from './FeedbackActions';
import Icon, { type IconName } from '../../components/Icon';
import Markdown from '../../components/ui/Markdown';
import { useSpaceEventsStore } from './spaceEventsStore';

/**
 * 空间助手对话流:只渲染 pi 契约的结构原语,运行时由 SpaceWorkspace 的
 * AssistantRuntimeProvider 提供。composer 上方为确认卡(confirm_request 事件驱动)。
 * 文本 part 走 markdown 渲染;工具调用渲染为图标 chip(进行中/完成/失败三态)。
 */
export default function SpaceThreadPane({ threadId }: { threadId: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col h-full">
      <ThreadPrimitive.Root className="flex flex-col h-full">
        <ThreadPrimitive.Viewport className="flex-1 min-h-0 overflow-y-auto px-4 py-5">
          <ThreadPrimitive.Messages components={{
            UserMessage,
            // 反馈入口要拿到 threadId 才能提交，而 components 只能收组件类型（无 props 通道）
            // —— 这里用闭包包一层把 threadId 注入进去。不接任何 props：消息正文由
            // MessagePrimitive 通过 context 拿，wrapper 只负责注入 threadId。
            AssistantMessage: () => <AssistantMessage threadId={threadId} />,
          }} />
          {/* 运行期常驻指示:工具间隙/模型静默期没有任何可见输出,靠底部三点动效提示会话仍在跑,避免"卡死"错觉 */}
          <ThreadPrimitive.If running>
            <RunningIndicator />
          </ThreadPrimitive.If>
        </ThreadPrimitive.Viewport>
        <ThreadPrimitive.ViewportFooter className="border-t p-3" style={{ borderColor: 'var(--border)' }}>
          <VerifyProgressCard />
          <SolidifyProgressCard />
          <ConfirmCard threadId={threadId} />
          <ComposerPrimitive.Root className="flex items-end gap-2">
            <ComposerPrimitive.Input
              minRows={1}
              maxRows={6}
              placeholder={t('assistant:composer.placeholder')}
              className="flex-1 resize-none rounded-md border px-3 py-2 text-[13px] outline-none"
              style={{ borderColor: 'var(--border)', background: 'var(--popover)', color: 'var(--foreground)' }}
            />
            <ThreadPrimitive.If running={false}>
              <ComposerPrimitive.Send
                className="press shrink-0 rounded-md px-3 py-2 text-[13px] text-white"
                style={{ background: 'var(--primary)' }}
              >
                {t('assistant:composer.send')}
              </ComposerPrimitive.Send>
            </ThreadPrimitive.If>
            <ThreadPrimitive.If running>
              <ComposerPrimitive.Cancel
                className="press shrink-0 rounded-md px-3 py-2 text-[13px] text-white"
                style={{ background: 'var(--destructive)' }}
              >
                {t('assistant:composer.stop')}
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

function AssistantMessage({ threadId }: { threadId: string }) {
  return (
    <div className="fade-up mb-4 group" style={{ color: 'var(--foreground)' }}>
      <div className="text-[13px]">
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
      <FeedbackActions threadId={threadId} />
    </div>
  );
}

/** 运行指示:running=true 期间常驻消息列表底部(thinking-dot 三点动效,与思考中段同一视觉语言)。
 *  思考流期间隐藏本身:模型推理时消息内已渲染「思考中」,再叠一只底部三点动效就是两套同形动画。
 *  二者语义互补——思考中=模型在推理(跟着消息走),正在运行=工具调用间隙/模型静默期(线程整体存活)。 */
function RunningIndicator() {
  const { t } = useTranslation();
  // 必须读 s.thread.messages[].parts（core 派生过 status 的 PartState），不能读
  // message.content——那是 react-pi messageProjection 的原始投影，reasoning part 根本
  // 没有 status 字段，p.status?.type==='running' 恒为 false，守卫形同虚设。
  // ThinkingPart 显示的「思考中」正是同一份派生 status，两边口径一致才互斥。
  const thinkingActive = useAuiState((s) =>
    s.thread.messages.some((m) =>
      m.parts.some((p) => p.type === 'reasoning' && p.status.type === 'running'),
    ),
  );
  if (thinkingActive) return null;
  return (
    <div className="mb-4 inline-flex items-center gap-1 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
      {t('assistant:runningIndicator')}
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
  const { t } = useTranslation();
  if (status.type !== 'running') return null;
  return (
    <div className="mb-2 inline-flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
      {t('assistant:thinking')}
      <span className="inline-flex items-center gap-0.5">
        <span className="thinking-dot" />
        <span className="thinking-dot" />
        <span className="thinking-dot" />
      </span>
    </div>
  );
}

/** 空间工具 → chip 文案与图标;未知工具返回 null 不渲染。label 为 i18n key,由调用方组件 t() 渲染。 */
function toolMeta(toolName: string, args: unknown): { icon: IconName; label: string; summary: string } | null {
  const a = (args ?? {}) as Record<string, unknown>;
  const action = typeof a.action === 'string' ? a.action : '';
  if (toolName === 'inspect_page') return { icon: 'search', label: 'assistant:tool.inspectPage', summary: typeof a.url === 'string' ? a.url : '' };
  if (toolName === 'announce_plan') return { icon: 'flag', label: 'assistant:tool.announcePlan', summary: typeof a.summary === 'string' ? a.summary : '' };
  if (toolName === 'manage_cases') return { icon: 'beaker', label: 'assistant:tool.manageCases', summary: action };
  if (toolName === 'manage_scenarios') return { icon: 'layers', label: 'assistant:tool.manageScenarios', summary: action };
  if (toolName === 'manage_environments') return { icon: 'globe', label: 'assistant:tool.manageEnvironments', summary: action };
  if (toolName === 'manage_plans') return { icon: 'listChecks', label: 'assistant:tool.managePlans', summary: action };
  if (toolName === 'verify_case') return { icon: 'beaker', label: 'assistant:tool.verifyCase', summary: typeof a.caseId === 'string' ? a.caseId.slice(0, 8) : '' };
  if (toolName === 'solidify_case') return { icon: 'sparkles', label: 'assistant:tool.solidifyCase', summary: typeof a.caseId === 'string' ? a.caseId.slice(0, 8) : '' };
  if (toolName.startsWith('repo_')) {
    return { icon: 'code', label: 'assistant:tool.readRepo', summary: typeof a.path === 'string' ? a.path : (typeof a.command === 'string' ? a.command : '') };
  }
  return null;
}

/** verify_case 实时进度卡：verify_progress SSE 事件驱动，逐条渲染步骤状态（运行中/通过/失败）。 */
function VerifyProgressCard() {
  const { t } = useTranslation();
  const vp = useSpaceEventsStore((s) => s.verifyProgress);
  if (!vp) return null;
  const done = vp.result !== null;
  return (
    <div
      className="fade-up mb-2 rounded-[var(--radius-md)] px-3 py-2 text-[12px]"
      style={{ background: 'var(--muted)', border: '1px solid var(--border)' }}
    >
      {/* 实时画面已移到右侧栏（LiveViewRail），此处只留步骤进度 */}
      <div className="mb-1.5 flex items-center gap-1.5" style={{ color: 'var(--muted-foreground)' }}>
        <Icon name="beaker" size={12} style={{ flexShrink: 0 }} />
        <span className="truncate">
          {t('assistant:verify.cardTitle', {
            done: vp.steps.filter((s) => s.status !== 'running').length,
            total: vp.total,
            targetSuffix: vp.targetUrl ? t('assistant:verify.targetUrlSuffix', { url: vp.targetUrl }) : '',
          })}
        </span>
        {vp.loginCache === 'hit' ? (
          <span style={{ color: 'var(--success)', flexShrink: 0 }}>
            {t('assistant:verify.loginCacheHit', {
              userSuffix: vp.loginUser ? t('assistant:verify.userSuffix', { user: vp.loginUser }) : '',
            })}
          </span>
        ) : vp.loginCache === 'miss' ? (
          <span style={{ flexShrink: 0 }}>
            {vp.loginUser ? t('assistant:verify.loginCacheMissUser', { user: vp.loginUser }) : t('assistant:verify.loginCacheMissNoUser')}
          </span>
        ) : null}
        {vp.stagedOps > 0 ? <span style={{ flexShrink: 0 }}>{t('assistant:verify.stagedOps', { count: vp.stagedOps })}</span> : null}
        {done ? (
          <Icon
            name={vp.result === 'passed' ? 'check' : 'close'}
            size={12}
            style={{ color: vp.result === 'passed' ? 'var(--success)' : 'var(--destructive)', flexShrink: 0 }}
          />
        ) : (
          <Icon name="loader" size={12} className="animate-spin" style={{ color: 'var(--primary)', flexShrink: 0 }} />
        )}
        {done && vp.cacheSaved ? <span style={{ flexShrink: 0 }}>{t('assistant:verify.cacheWritten')}</span> : null}
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
              {t('cases:stepOrderN', { order: s.order })}
              {s.brief ? t('assistant:verify.stepBriefSuffix', { brief: s.brief }) : ''}
              {s.status === 'failed' && s.reason ? ` — ${s.reason}` : ''}
              {s.durationMs != null && s.status !== 'running' ? t('assistant:verify.stepDuration', { sec: (s.durationMs / 1000).toFixed(1) }) : ''}
              {s.login === 'logged-in' ? t('assistant:verify.stepLoggedIn') : ''}
            </span>
          </div>
        ))}
        {vp.replay ? (
          <div className="flex items-start gap-1.5" style={{ color: 'var(--muted-foreground)' }}>
            <Icon
              name={vp.replay.status === 'running' ? 'loader' : vp.replay.status === 'passed' ? 'check' : 'close'}
              size={11}
              className={vp.replay.status === 'running' ? 'animate-spin' : ''}
              style={{
                color:
                  vp.replay.status === 'running'
                    ? 'var(--primary)'
                    : vp.replay.status === 'passed'
                      ? 'var(--success)'
                      : 'var(--destructive)',
                flexShrink: 0,
                marginTop: 2,
              }}
            />
            <span className="min-w-0 break-all">
              {t('assistant:verify.compiledReplay')}
              {vp.replay.status === 'failed' && vp.replay.reason ? ` — ${vp.replay.reason}` : ''}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** solidify_case 实时进度卡：solidify_progress SSE 事件驱动，单行指示（start/end 两相）。
 *  固化会真实再执行一遍用例，全程数分钟——单行 loader → 结果（固化数/保持数/失败原因）。 */
function SolidifyProgressCard() {
  const { t } = useTranslation();
  const sp = useSpaceEventsStore((s) => s.solidifyProgress);
  if (!sp) return null;
  const done = sp.result !== null;
  const ok = sp.result === 'solidified';
  let status: string;
  if (!done) status = t('cases:status.running');
  else if (ok) status = t('assistant:solidify.done', { count: sp.solidified ?? 0, keptSuffix: sp.kept ? t('assistant:solidify.keptSuffix', { count: sp.kept }) : '' });
  else if (sp.result === 'nothing-solidified') status = sp.kept ? t('assistant:solidify.nothingWithKept', { count: sp.kept }) : t('assistant:solidify.nothing');
  else status = sp.reason ? `${t('cases:status.failed')} — ${sp.reason}` : t('cases:status.failed');
  return (
    <div
      className="fade-up mb-2 rounded-[var(--radius-md)] px-3 py-2 text-[12px]"
      style={{ background: 'var(--muted)', border: '1px solid var(--border)', color: 'var(--muted-foreground)' }}
    >
      {/* 实时画面已移到右侧栏（LiveViewRail），此处只留单行状态 */}
      <div className="flex items-center gap-1.5">
      <Icon name="sparkles" size={12} style={{ flexShrink: 0 }} />
      <span className="truncate">
        {t('assistant:solidify.cardTitle', {
          solidifiable: sp.solidifiable,
          total: sp.total,
          statusSuffix: status ? t('assistant:solidify.statusSuffix', { status }) : '',
        })}
      </span>
      {done ? (
        <Icon
          name={ok || sp.result === 'nothing-solidified' ? 'check' : 'close'}
          size={12}
          style={{
            color: sp.result === 'failed' ? 'var(--destructive)' : 'var(--success)',
            flexShrink: 0,
          }}
        />
      ) : (
        <Icon name="loader" size={12} className="animate-spin" style={{ color: 'var(--primary)', flexShrink: 0 }} />
      )}
      </div>
    </div>
  );
}

/** 工具调用 chip:进行中(loader 旋转)/完成(check)/失败(✗ destructive),让操作过程有渐进反馈。 */
function ToolActivity(part: ToolCallMessagePartProps) {
  const { t } = useTranslation();
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
        {t(meta.label)}
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
