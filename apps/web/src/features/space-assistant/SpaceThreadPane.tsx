import { useEffect, useMemo, useState } from 'react';
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  QueueItemPrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  type Attachment,
  type ReasoningMessagePartProps,
  type TextMessagePartProps,
  type ToolCallMessagePartProps,
} from '@assistant-ui/react';
import { useTranslation } from 'react-i18next';
import { localizeApiError } from '../../i18n';
import { useUIStore } from '../../stores/ui';
import { usePiRuntimeExtras, usePiThreadState } from '@assistant-ui/react-pi';
import ConfirmCard from './ConfirmCard';
import FeedbackActions from './FeedbackActions';
import Icon, { type IconName } from '../../components/Icon';
import Markdown from '../../components/ui/Markdown';
import { useSpaceEventsStore, type ArtifactItem } from './spaceEventsStore';
import { api, ApiError } from '../../api/client';

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
          <ArtifactCards threadId={threadId} />
          <RuntimeNotice />
          <QueuePanel />
          <ConfirmCard threadId={threadId} />
          <SuggestionRow />
          <ComposerPrimitive.Root className="flex items-end gap-2">
            {/* 图片附件:AddAttachment 走 <input type=file>,Accept 由 SimpleImageAttachmentAdapter
                (image/*) 在 useComposerAddAttachment 里从 composer 状态读,这里不用再传 accept。
                附件在发送时由 ThreadController 转成 pi 的 ImageContent 随 input.attachments 上行。 */}
            <ComposerPrimitive.AttachmentDropzone className="flex min-w-0 flex-1 flex-col gap-1.5">
              <ComposerPrimitive.Attachments>
                {({ attachment }) => <ComposerAttachment attachment={attachment} removeLabel={t('assistant:attachment.remove')} />}
              </ComposerPrimitive.Attachments>
              <div className="flex items-end gap-2">
                <ComposerPrimitive.AddAttachment
                  className="btn-tint shrink-0 rounded-md px-2 py-2"
                  style={{ color: 'var(--muted-foreground)' }}
                  aria-label={t('assistant:attachment.add')}
                >
                  <Icon name="plus" size={14} />
                </ComposerPrimitive.AddAttachment>
                <ComposerPrimitive.Input
                  minRows={1}
                  maxRows={6}
                  placeholder={t('assistant:composer.placeholder')}
                  className="min-w-0 flex-1 resize-none rounded-md border px-3 py-2 text-[13px] outline-none"
                  style={{ borderColor: 'var(--border)', background: 'var(--popover)', color: 'var(--foreground)' }}
                />
                <ThreadPrimitive.If running={false}>
                  <ComposerPrimitive.Send
                    className="btn-feedback shrink-0 rounded-md px-3 py-2 text-[13px] text-white"
                    style={{ background: 'var(--primary)' }}
                  >
                    {t('assistant:composer.send')}
                  </ComposerPrimitive.Send>
                </ThreadPrimitive.If>
                <ThreadPrimitive.If running>
                  <ComposerPrimitive.Cancel
                    className="btn-feedback shrink-0 rounded-md px-3 py-2 text-[13px] text-white"
                    style={{ background: 'var(--destructive)' }}
                  >
                    {t('assistant:composer.stop')}
                  </ComposerPrimitive.Cancel>
                </ThreadPrimitive.If>
              </div>
            </ComposerPrimitive.AttachmentDropzone>
          </ComposerPrimitive.Root>
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Root>
    </div>
  );
}

/**
 * 推荐追问 chip 行:AI 回答落定后由 SpaceWorkspace 的 SuggestionWatcher 拉取、经
 * runtime suggestions 通道下发(见该组件注释)。只在空闲态且有建议时渲染——空数组时
 * ThreadPrimitive.Suggestions 自身返回 null,但外层容器仍需靠 count 守卫,否则会留
 * 一个带 mb 的空 div 把 composer 顶下去。点一下即发送(send),对齐「追问」语义。
 */
function SuggestionRow() {
  const { t } = useTranslation();
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const count = useAuiState((s) => s.thread.suggestions.length);
  if (isRunning || count === 0) return null;
  return (
    <div className="fade-up mb-2 flex flex-wrap gap-1.5">
      <span className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
        {t('assistant:suggestion.title')}
      </span>
      <ThreadPrimitive.Suggestions>
        {({ suggestion }) => (
          <SuggestionPrimitive.Trigger
            send
            className="btn-tint rounded-full border px-2.5 py-1 text-[12px] hover:border-[var(--muted-foreground)]"
            style={{ borderColor: 'var(--border)', background: 'var(--popover)', color: 'var(--foreground)' }}
          >
            {/* 后端只给 prompt(ThreadSuggestion.title 可选),正文直接渲染 prompt 文本。 */}
            {suggestion.prompt}
          </SuggestionPrimitive.Trigger>
        )}
      </ThreadPrimitive.Suggestions>
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
        {/* 附件必须给 Image 组件:assistant-ui 的默认 Image part 渲染是 null,
            不覆盖的话用户发的截图在历史消息里完全不可见。 */}
        <MessagePrimitive.Parts components={{ Image: UserImagePart }} />
      </div>
    </div>
  );
}

/** 用户消息里的图片 part。max-h 限制高度,避免一张竖长截图把整条消息撑到屏外。 */
function UserImagePart({ image }: { image: string }) {
  return (
    <img
      src={image}
      alt=""
      className="my-1 max-h-64 max-w-full rounded-[var(--radius-sm)] object-contain"
    />
  );
}

/** 输入框上方的待发送图片附件。
 *
 *  src 取两处：发送前 attachment 只有 File(adapter 的 add 阶段不读内容，状态是
 *  requires-action/composer-send)，走 objectURL；一旦进入提交/完成态就有了
 *  content 里的 dataURL，直接用。objectURL 必须随 file 变化重建并 revoke，
 *  放在渲染期调用会每次渲染泄漏一个 URL。 */
function ComposerAttachment({ attachment, removeLabel }: { attachment: Attachment; removeLabel: string }) {
  const dataUrl = (attachment.content as { image?: string }[] | undefined)?.[0]?.image;
  const objectUrl = useMemo(
    () => (attachment.file ? URL.createObjectURL(attachment.file) : undefined),
    [attachment.file],
  );
  useEffect(() => () => { if (objectUrl) URL.revokeObjectURL(objectUrl); }, [objectUrl]);
  return (
    <AttachmentPrimitive.Root className="flex w-fit max-w-full items-start gap-1" style={{ color: 'var(--muted-foreground)' }}>
      <AttachmentPrimitive.unstable_Thumb>
        <img
          src={dataUrl ?? objectUrl ?? ''}
          alt={attachment.name}
          className="h-14 w-auto rounded-[var(--radius-sm)] object-cover"
        />
      </AttachmentPrimitive.unstable_Thumb>
      <AttachmentPrimitive.Remove
        className="btn-tint shrink-0 rounded-[var(--radius-sm)]"
        aria-label={removeLabel}
      >
        <Icon name="close" size={12} />
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
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

/** 思考段：进行中给"思考中…"三点动画；完成后折叠成一行「已思考」，
 *  点击展开原始推理文本。推理文本是判断「模型为什么这么决策」的唯一信息源
 *  （尤其长任务失败时），不能像早期实现那样直接丢弃。 */
function ThinkingPart({ status, text }: ReasoningMessagePartProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // 折叠态下渲染 reasoning 全文代价高（大段思考可达数千 token），只在展开时挂载
  if (status.type !== 'running') {
    if (!text) return null;
    return (
      <div className="mb-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="btn-tint inline-flex items-center gap-1 text-[12px] hover:underline underline-offset-2"
          style={{ color: 'var(--muted-foreground)' }}
          aria-expanded={open}
        >
          <Icon name="chevronRight" size={11} style={{ flexShrink: 0, transform: open ? 'rotate(90deg)' : 'none' }} />
          <span>{t('assistant:thinkingDone')}</span>
        </button>
        {open && (
          <div
            className="mt-1 whitespace-pre-wrap break-words rounded-[var(--radius-sm)] px-2.5 py-2 text-[12px] leading-relaxed"
            style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}
          >
            {text}
          </div>
        )}
      </div>
    );
  }
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

/** AI 产出文件下载卡：artifact SSE 事件驱动，文件名+大小+下载按钮。
 *  不随新一轮对话清空——交付物常驻到线程结束/30min TTL 过后下载会 410（卡片仍在，点下载报错可感知）。 */
function ArtifactCards({ threadId }: { threadId: string }) {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const items = useSpaceEventsStore((s) => s.artifactsByThread.get(threadId)) ?? [];
  if (items.length === 0) return null;
  const download = async (item: ArtifactItem) => {
    try {
      const { blob, filename } = await api.downloadArtifact(threadId, item.token);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      // 过期（410）/已被清扫（404）是被预期的失败态：token 30min TTL，给出含「让 AI 重新生成」的引导；
      // 其余失败（网络断/500）走通用错误文案，避免把一切归因为过期。
      if (e instanceof ApiError && (e.status === 410 || e.status === 404)) {
        toast(t('assistant:artifact.expired'), 'error');
      } else {
        toast(localizeApiError(e as Error), 'error');
      }
    }
  };
  return (
    <>
      {items.map((item) => (
        <div
          key={item.token}
          className="fade-up mb-2 flex items-center gap-2 rounded-[var(--radius-md)] px-3 py-2 text-[12px]"
          style={{ background: 'var(--muted)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
        >
          <Icon name="download" size={12} style={{ flexShrink: 0, color: 'var(--primary)' }} />
          <span className="min-w-0 truncate">{item.name}</span>
          <span className="flex-shrink-0" style={{ color: 'var(--muted-foreground)' }}>
            {Math.max(1, Math.round(item.size / 1024))} KB{item.count != null ? ` · ${t('assistant:artifact.count', { count: item.count })}` : ''}
          </span>
          <button
            type="button"
            onClick={() => void download(item)}
            className="btn-tint ml-auto shrink-0 rounded-[var(--radius-sm)] px-1.5 py-0.5 hover:underline underline-offset-2"
            style={{ color: 'var(--primary)' }}
          >
            {t('assistant:artifact.download')}
          </button>
        </div>
      ))}
    </>
  );
}

/** 运行期状态提示：上下文压缩 / API 自动重试。
 *
 *  这两种状态在改之前都是「静默」的：压缩时模型突然沉默十几秒、自动重试时一段空白
 *  然后突然出结果——都表现为「界面卡住了」。数据全部来自 react-pi 已有的 PiThreadState
 *  （后端 mapSessionEvent 的 default 分支原样透传这些事件），此处只做展示。
 *  排队消息另有 QueuePanel（内容可见 + 可撤回），不在这里只报数量。 */
function RuntimeNotice() {
  const { t } = useTranslation();
  const compaction = usePiThreadState((s) => s.compaction);
  const retry = usePiThreadState((s) => s.retry);
  if (!compaction.active && !retry.active) return null;
  return (
    <div className="mb-2 flex flex-col gap-1">
      {compaction.active && (
        <RuntimeNoticeRow
          icon="loader"
          spin
          color="var(--primary)"
          text={t('assistant:notice.compacting', {
            reason: t(`assistant:notice.compactReason.${compaction.reason ?? 'manual'}`),
          })}
        />
      )}
      {retry.active && (
        <RuntimeNoticeRow
          icon="loader"
          spin
          color="var(--warning)"
          text={t('assistant:notice.retrying', { attempt: retry.attempt })}
        />
      )}
    </div>
  );
}

/** 排队消息面板:运行中发送的消息先进 Pi 的服务端队列,不在对话流里。
 *  只显示「已排队 N 条」用户看不到自己刚发出去的话去了哪,也无从撤回——
 *  这里逐条列出原文,并提供「撤回」把内容还原回输入框。
 *  面板数据来自 ComposerPrimitive.Queue(react-pi 把 Pi 的 queue 适配到 composer.queue),
 *  撤回走 usePiRuntimeExtras().clearQueue → POST /queue/clear(见 router.ts)。 */
function QueuePanel() {
  const { t } = useTranslation();
  const extras = usePiRuntimeExtras();
  const aui = useAui();
  const draft = useAuiState((s) => s.composer.text);
  const queued = useAuiState((s) => s.composer.queue.length);
  const [busy, setBusy] = useState(false);
  if (queued === 0) return null;
  const withdraw = async () => {
    setBusy(true);
    try {
      const cleared = await extras.clearQueue();
      // 还原文字:被撤回的排在输入框已有草稿之后,避免覆盖用户正在写的内容。
      const restored = [...cleared.steering, ...cleared.followUp].join('\n');
      aui.composer.setText([draft, restored].filter(Boolean).join('\n'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="fade-up mb-2 flex flex-col gap-1 rounded-[var(--radius-md)] px-3 py-2 text-[12px]"
      style={{ background: 'var(--muted)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-center gap-1.5" style={{ color: 'var(--muted-foreground)' }}>
        <Icon name="clock" size={12} style={{ flexShrink: 0 }} />
        <span>{t('assistant:queue.title', { count: queued })}</span>
        <button
          type="button"
          onClick={() => void withdraw()}
          disabled={busy}
          className="btn-tint ml-auto shrink-0 rounded-[var(--radius-sm)] px-1.5 py-0.5 hover:underline underline-offset-2"
          style={{ color: 'var(--primary)' }}
        >
          {busy ? t('assistant:queue.withdrawing') : t('assistant:queue.withdraw')}
        </button>
      </div>
      <ComposerPrimitive.Queue>
        {() => (
          <div className="min-w-0 break-words" style={{ color: 'var(--muted-foreground)' }}>
            <QueueItemPrimitive.Text />
          </div>
        )}
      </ComposerPrimitive.Queue>
    </div>
  );
}

function RuntimeNoticeRow({
  icon,
  text,
  color,
  spin,
}: {
  icon: IconName;
  text: string;
  color: string;
  spin?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
      <Icon name={icon} size={12} className={spin ? 'animate-spin' : ''} style={{ color, flexShrink: 0 }} />
      <span className="truncate">{text}</span>
    </div>
  );
}

/** 工具调用 chip:进行中(loader 旋转)/完成(check)/失败(✗ destructive),让操作过程有渐进反馈。
 *  完成后可展开查看工具原始入参/出参——排查 isError 的工具时这是唯一信息源,
 *  chip 上的一行 summary 不足以定位问题(verify_case 的机械回放输出、repo_read 读到的代码都在这)。 */
function ToolActivity(part: ToolCallMessagePartProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const meta = toolMeta(part.toolName, part.args);
  if (!meta) return null;
  const running = part.status.type === 'running';
  const statusColor = running ? 'var(--primary)' : part.isError ? 'var(--destructive)' : 'var(--success)';
  const detail = toolDetail(part);
  return (
    <div className="mb-1.5">
      <button
        type="button"
        onClick={() => detail && setOpen((v) => !v)}
        disabled={!detail}
        className="btn-tint flex w-fit max-w-full items-center gap-1.5 rounded-[var(--radius-md)] px-2 py-1 text-[12px]"
        style={{ background: 'var(--muted)', border: '1px solid var(--border)', color: 'var(--muted-foreground)', cursor: detail ? 'pointer' : 'default' }}
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
        {detail && (
          <Icon
            name="chevronRight"
            size={11}
            style={{ flexShrink: 0, transform: open ? 'rotate(90deg)' : 'none' }}
          />
        )}
      </button>
      {open && detail && (
        <pre
          className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-[var(--radius-sm)] px-2.5 py-2 text-[11px] leading-relaxed"
          style={{ background: 'var(--muted)', border: '1px solid var(--border)', color: 'var(--muted-foreground)' }}
        >
          {detail}
        </pre>
      )}
    </div>
  );
}

/** 工具入参/出参的可读文本。空结果(ok/'' 之类)返回 null —— chip 保持不可展开,
 *  免得用户点开只看到一行 "ok"。 */
function toolDetail(part: ToolCallMessagePartProps): string | null {
  const parts: string[] = [];
  const argsText = part.argsText?.trim();
  if (argsText && argsText !== '{}') parts.push(argsText);
  if (part.result !== undefined && !part.isPreliminary) {
    // 工具结果统一是 { content: [{type:'text',text}], isError }（session.ts 的 defineTool 包装）
    const text = toolResultText(part.result);
    if (text && text !== 'ok') parts.push(text);
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/** 从工具出参里抽出人类可读正文。兼容两种形状：pi 的 { content:[{type:'text',text}] }
 *  和 reconcile 后 assistant-ui 可能给出的裸字符串。 */
function toolResultText(result: unknown): string {
  if (typeof result === 'string') return result.trim();
  if (result && typeof result === 'object' && 'content' in result) {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      return content
        .map((c) => {
          if (c && typeof c === 'object' && 'text' in c) return String((c as { text?: unknown }).text ?? '');
          return '';
        })
        .filter(Boolean)
        .join('\n')
        .trim();
    }
  }
  if (result === undefined || result === null) return '';
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}
