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
import { toolMeta } from './toolMeta';
import { splitUploadedFileTags, type UploadedFileMeta } from './uploadedFileTag';
import { api, ApiError } from '../../api/client';

/**
 * Space assistant conversation flow: renders only pi-contract structural primitives, runtime provided by
 * SpaceWorkspace's AssistantRuntimeProvider. Above the composer sit confirm cards (confirm_request event driven).
 * Text parts render as markdown; tool calls render as icon chips (running/done/failed three states).
 */
export default function SpaceThreadPane({ threadId }: { threadId: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col h-full">
      <ThreadPrimitive.Root className="flex flex-col h-full">
        <ThreadPrimitive.Viewport className="flex-1 min-h-0 overflow-y-auto px-4 py-5">
          <ThreadPrimitive.Messages components={{
            UserMessage,
            // The feedback entry needs threadId to submit, while components only accept component types (no props channel)
            // — so wrap with a closure to inject threadId. Takes no props: message body is fetched by
            // MessagePrimitive through context, the wrapper only injects threadId.
            AssistantMessage: () => <AssistantMessage threadId={threadId} />,
          }} />
          {/* Always-visible running indicator: tool gaps/model silence periods have no visible output, bottom three-dot animation hints the thread is still alive, avoiding the "stuck" illusion */}
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
            {/* Attachments: AddAttachment uses <input type=file>; Accept is aggregated by CompositeAttachmentAdapter
                from each adapter's accept (image/*, .docx/.xlsx plus two mimes) and read via composer state,
                no need to pass accept here. Images are converted to pi's ImageContent at send time, uploaded with input.attachments;
                documents (docx/xlsx) are assembled by FileAttachmentAdapter into a <uploaded-file/> text tag into the body. */}
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
 * Suggestion chip row: fetched by SpaceWorkspace's SuggestionWatcher after each AI answer settles, delivered via the
 * runtime suggestions channel (see that component's comment). Rendered only when idle and suggestions exist —
 * ThreadPrimitive.Suggestions itself returns null on empty arrays, but the outer container still needs the count guard,
 * otherwise an empty div with mb remains and pushes the composer down. One click sends (send), matching the "follow-up" semantic.
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
            {/* Backend only provides prompt (ThreadSuggestion.title optional); render the prompt text directly as the body. */}
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
        {/* Attachments must be given the Image component: assistant-ui's default Image part renders null,
            without this override user screenshots are completely invisible in history messages. */}
        <MessagePrimitive.Parts components={{ Image: UserImagePart, Text: UserTextPart }} />
      </div>
    </div>
  );
}

/** Image part in user messages. max-h caps height, keeping one tall screenshot from stretching the whole message off-screen. */
function UserImagePart({ image }: { image: string }) {
  return (
    <img
      src={image}
      alt=""
      className="my-1 max-h-64 max-w-full rounded-[var(--radius-sm)] object-contain"
    />
  );
}

/** Text part in user messages: folds <uploaded-file …/> reference tags into attachment chips, rest unchanged.
 *  Display-layer transform only — the message original (tags included) stays intact into the pi thread and the reconciliation key. */
function UserTextPart({ text }: TextMessagePartProps) {
  const parts = splitUploadedFileTags(text);
  if (parts.length === 1 && typeof parts[0] === 'string') return <>{parts[0]}</>;
  return (
    <>
      {parts.map((p, i) => (typeof p === 'string' ? <span key={i}>{p}</span> : <UploadedFileChip key={i} meta={p} />))}
    </>
  );
}

/** Document attachment chip in history messages: icon + filename + char count. */
function UploadedFileChip({ meta }: { meta: UploadedFileMeta }) {
  const chars = meta.chars === 'unknown' ? '' : ` · ${Number(meta.chars).toLocaleString()} 字`;
  return (
    <span
      className="my-1 inline-flex max-w-full items-center gap-1 rounded-[var(--radius-sm)] border px-2 py-0.5 text-[12px]"
      style={{ borderColor: 'var(--border)', background: 'var(--popover)', color: 'var(--muted-foreground)' }}
    >
      <Icon name="file" size={12} />
      <span className="max-w-[240px] truncate">{meta.name}</span>
      <span>{chars}</span>
    </span>
  );
}

/** Document attachment detection (.docx/.xlsx): contentType (the browser-provided wordprocessingml/spreadsheetml mime)
 *  or extension fallback. On no match renders as image (an xlsx falling into the img branch renders an empty box — the first regression to surface). */
function isDocumentAttachment(a: Attachment): boolean {
  return /\.(docx|xlsx)$/i.test(a.name)
    || /wordprocessingml|spreadsheetml/i.test(a.contentType ?? '');
}

/** Pending-send image attachments above the input box.
 *
 *  src comes from two places: before sending the attachment only has File (the adapter's add phase doesn't read content,
 *  status is requires-action/composer-send), so use objectURL; once in submitted/done state there is a
 *  dataURL in content, use it directly. objectURL must be rebuilt and revoked as file changes;
 *  calling during render would leak one URL per render. */
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
        {isDocumentAttachment(attachment) ? (
          <div
            className="flex h-14 w-32 items-center gap-1.5 rounded-[var(--radius-sm)] border px-2"
            style={{ borderColor: 'var(--border)', background: 'var(--popover)' }}
          >
            <Icon name="file" size={14} />
            <span className="truncate text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
              {attachment.name}
            </span>
          </div>
        ) : (
          <img
            src={dataUrl ?? objectUrl ?? ''}
            alt={attachment.name}
            className="h-14 w-auto rounded-[var(--radius-sm)] object-cover"
          />
        )}
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
            // The compaction marker projected by pi (role:'compactionSummary' message) lands as this data part;
            // without a registered renderer it's a blank block — registered it becomes the visible "context compacted" divider row.
            data: { by_name: { 'pi-compaction-summary': CompactionSummaryPart } },
          }}
        />
        {/* LLM failure (stopReason=error): the raw error must be visible, otherwise the user sees zero feedback */}
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

/** Running indicator: pinned at the message list bottom while running=true (thinking-dot three-dot animation, same visual language as the thinking section).
 *  Hides itself during thinking streams: while the model reasons the message already renders "thinking", stacking another bottom three-dot animation makes two same-shaped animations.
 *  Semantics are complementary — thinking = the model is reasoning (follows the message), running = tool-call gaps/model silence (thread alive as a whole). */
function RunningIndicator() {
  const { t } = useTranslation();
  // Must read s.thread.messages[].parts (PartState with status derived by core), not
  // message.content — that is react-pi messageProjection's raw projection; the reasoning part has no
  // status field at all, p.status?.type==='running' is always false, the guard would be useless.
  // The "thinking" shown by ThinkingPart is exactly the same derived status; both sides must agree to be mutually exclusive.
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

/** Text part → markdown render (incrementally re-parsed as text streams in; magnitude negligible). */
function TextPart({ text }: TextMessagePartProps) {
  return <Markdown text={text} />;
}

/** Compaction marker part (projected from the pi thread's compaction entry, may appear mid-stream after snapshot merge):
 *  centered divider + token count, summary collapsible — it is the reason footnote for "history before this point was compacted out of the
 *  model context and stitched back into the conversation flow by the server in time order". */
function CompactionSummaryPart({ data }: { data?: { summary?: string; tokensBefore?: number | null } }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-1 py-2 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
      <div className="flex w-full items-center gap-2">
        <span className="h-px flex-1" style={{ background: 'var(--border)' }} />
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <Icon name="clock" size={11} />
          {t('assistant:history.compaction')}
          {data?.tokensBefore != null
            ? ` · ${t('assistant:history.compactionTokens', { count: data.tokensBefore })}`
            : ''}
        </span>
        <span className="h-px flex-1" style={{ background: 'var(--border)' }} />
      </div>
      {data?.summary && (
        <details className="group w-full max-w-[520px]">
          <summary className="inline-flex cursor-pointer list-none items-center justify-center gap-1 text-[12px] hover:underline underline-offset-2 [&::-webkit-details-marker]:hidden">
            {t('assistant:history.compactionSummary')}
            <Icon name="chevronRight" size={11} className="transition-transform group-open:rotate-90" />
          </summary>
          <div className="mt-1 rounded-[var(--radius-sm)] px-2.5 py-2 text-left" style={{ background: 'var(--muted)' }}>
            <Markdown text={data.summary} />
          </div>
        </details>
      )}
    </div>
  );
}

/** Thinking section: while running shows a "thinking…" three-dot animation; when done collapses into a single "thought" row,
 *  click to expand the raw reasoning text. The reasoning text is the only source for judging "why the model decided this way"
 *  (especially for long-task failures), must not be discarded outright like the early implementation did. */
function ThinkingPart({ status, text }: ReasoningMessagePartProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // Rendering the full reasoning text in the collapsed state is costly (a large thought can reach thousands of tokens); mount only when expanded
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

/** verify_case live progress card: driven by verify_progress SSE events, renders step states one by one (running/passed/failed).
 *  Step details are collapsible: a real run leaves a dozen-step list pinned above the input box, crowding the input area — click the title row to collapse. */
function VerifyProgressCard() {
  const { t } = useTranslation();
  const vp = useSpaceEventsStore((s) => s.verifyProgress);
  const [open, setOpen] = useState(true);
  // A new live run (different case) auto-expands — the previous round's collapsed state must not carry into the new round.
  const caseId = vp?.caseId;
  useEffect(() => { setOpen(true); }, [caseId]);
  if (!vp) return null;
  const done = vp.result !== null;
  return (
    <div
      className="fade-up mb-2 rounded-[var(--radius-md)] px-3 py-2 text-[12px]"
      style={{ background: 'var(--muted)', border: '1px solid var(--border)' }}
    >
      {/* Live view moved to the right rail (LiveViewRail); only step progress remains here */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="btn-tint mb-1.5 flex w-full items-center gap-1.5 rounded text-left"
        style={{ color: 'var(--muted-foreground)' }}
      >
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
        {done && vp.result === 'cancelled' ? (
          <span style={{ flexShrink: 0 }}>{t('assistant:verify.cancelled')}</span>
        ) : null}
        {done ? (
          <Icon
            name={vp.result === 'passed' ? 'check' : 'close'}
            size={12}
            style={{
              color:
                vp.result === 'passed'
                  ? 'var(--success)'
                  : vp.result === 'cancelled'
                    ? 'var(--muted-foreground)'
                    : 'var(--destructive)',
              flexShrink: 0,
            }}
          />
        ) : (
          <Icon name="loader" size={12} className="animate-spin" style={{ color: 'var(--primary)', flexShrink: 0 }} />
        )}
        {done && vp.cacheSaved ? <span style={{ flexShrink: 0 }}>{t('assistant:verify.cacheWritten')}</span> : null}
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} style={{ flexShrink: 0, marginLeft: 'auto' }} />
      </button>
      {open && (
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
      )}
    </div>
  );
}

/** solidify_case live progress card: driven by solidify_progress SSE events, single-line indicator (start/end phases).
 *  Solidification actually re-executes the case, taking minutes — single-line loader → result (solidified count/kept count/failure reason). */
function SolidifyProgressCard() {
  const { t } = useTranslation();
  const sp = useSpaceEventsStore((s) => s.solidifyProgress);
  if (!sp) return null;
  const done = sp.result !== null;
  const ok = sp.result === 'solidified';
  let status: string;
  if (!done) status = t('cases:status.running');
  else if (ok) status = t('assistant:solidify.done', { count: sp.solidified ?? 0, keptSuffix: sp.kept ? t('assistant:solidify.keptSuffix', { count: sp.kept }) : '' });
  else if (sp.result === 'cancelled') status = t('assistant:solidify.cancelled');
  else if (sp.result === 'nothing-solidified') status = sp.kept ? t('assistant:solidify.nothingWithKept', { count: sp.kept }) : t('assistant:solidify.nothing');
  else status = sp.reason ? `${t('cases:status.failed')} — ${sp.reason}` : t('cases:status.failed');
  return (
    <div
      className="fade-up mb-2 rounded-[var(--radius-md)] px-3 py-2 text-[12px]"
      style={{ background: 'var(--muted)', border: '1px solid var(--border)', color: 'var(--muted-foreground)' }}
    >
      {/* Live view moved to the right rail (LiveViewRail); only the single-line status remains here */}
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
            color:
              sp.result === 'failed'
                ? 'var(--destructive)'
                : sp.result === 'cancelled'
                  ? 'var(--muted-foreground)'
                  : 'var(--success)',
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

/** AI-produced file download card: driven by artifact SSE events, filename+size+download button.
 *  Not cleared when a new conversation round starts — deliverables persist until the thread ends/after the 30min TTL downloads 410 (card remains, clicking download errors visibly). */
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
      // Expired (410)/already swept (404) are expected failure states: tokens have a 30min TTL, guide with "ask the AI to regenerate";
      // other failures (network drop/500) use the generic error text, avoiding attributing everything to expiry.
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

/** Runtime status notice: context compaction / API auto-retry.
 *
 *  Both states were "silent" before this change: during compaction the model suddenly goes quiet for a dozen seconds, during auto-retry a blank
 *  stretch then suddenly a result — both present as "the UI is stuck". Data comes entirely from react-pi's existing PiThreadState
 *  (the backend's mapSessionEvent default branch passes these events through unchanged); this only displays.
 *  Queued messages have their own QueuePanel (content visible + withdrawable); don't just report a count here. */
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

/** Queued message panel: messages sent while running first enter Pi's server-side queue, not the conversation flow.
 *  Showing only "N queued", the user can't see where their just-sent words went, nor withdraw them —
 *  this lists each original text and provides "withdraw" to restore the content back into the input box.
 *  Panel data comes from ComposerPrimitive.Queue (react-pi adapts Pi's queue to composer.queue);
 *  withdraw goes through usePiRuntimeExtras().clearQueue → POST /queue/clear (see router.ts). */
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
      // Restore text: withdrawn content is appended after the existing draft in the input box, avoiding overwriting what the user is writing.
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

/** Tool call chip: running (loader spin)/done (check)/failed (✗ destructive), giving progressive feedback on the operation process.
 *  After completion it expands to show the tool's raw input/output — when troubleshooting tools with isError this is the only source,
 *  the one-line summary on the chip is not enough to locate the problem (verify_case's mechanical replay output, code read by repo_read are all here). */
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

/** Human-readable text for tool input/output. Empty results (ok/'' etc.) return null — the chip stays non-expandable,
 *  so the user doesn't click open only to see a single line "ok". */
function toolDetail(part: ToolCallMessagePartProps): string | null {
  const parts: string[] = [];
  const argsText = part.argsText?.trim();
  if (argsText && argsText !== '{}') parts.push(argsText);
  if (part.result !== undefined && !part.isPreliminary) {
    // Tool results are uniformly { content: [{type:'text',text}], isError } (session.ts's defineTool wrapper)
    const text = toolResultText(part.result);
    if (text && text !== 'ok') parts.push(text);
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/** Extract human-readable body text from tool output. Handles two shapes: pi's { content:[{type:'text',text}] }
 *  and the bare strings assistant-ui may give after reconcile. */
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
