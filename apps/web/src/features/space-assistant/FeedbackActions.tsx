import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuiState } from '@assistant-ui/react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { localizeApiError } from '../../i18n';
import { useUIStore } from '../../stores/ui';

/** The Carbon icon library has no thumb icons; two 16px paths are inlined locally to avoid touching the shared Icon map for two glyphs. */
function ThumbUp({ filled }: { filled: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden focusable="false"
      fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.3">
      <path d="M5 14H3.5A1.5 1.5 0 0 1 2 12.5v-4A1.5 1.5 0 0 1 3.5 7H5v7zM5 7l3.2-4.2A1 1 0 0 1 9.6 3.4V6h2.9a1.5 1.5 0 0 1 1.47 1.83l-1 5A1.5 1.5 0 0 1 11.5 14H5" strokeLinejoin="round" />
    </svg>
  );
}

function ThumbDown({ filled }: { filled: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden focusable="false"
      fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.3">
      <path d="M11 2h1.5A1.5 1.5 0 0 1 14 3.5v4a1.5 1.5 0 0 1-1.5 1.5H11v-7zM11 9l-3.2 4.2a1 1 0 0 1-1.4-.6V10H3.5a1.5 1.5 0 0 1-1.47-1.83l1-5A1.5 1.5 0 0 1 4.5 2H11" strokeLinejoin="round" />
    </svg>
  );
}

/** Extract plain text from the projected message.parts (tool-call parts carry no readable body and are skipped). */
function excerptOf(parts: readonly { type: string; text?: string }[]): string {
  return parts.filter((p) => p.type === 'text' && p.text).map((p) => p.text).join('\n').slice(0, 500);
}

/**
 * Feedback entry on AI replies (Phase 1 only collects; nothing consumes it yet).
 *
 * Deliberately not using the framework's ActionBarPrimitive.FeedbackPositive/Negative: its submit comes from the runtime's
 * useActionBarFeedback*, and react-pi's dist contains no feedback implementation at all → the buttons would be permanently disabled.
 * Here we build our own buttons + call this project's API directly.
 *
 * Anchor notes: message.id is only a positional index in the projection layer (pi-msg:<index>); it drifts during streaming
 * and can't be reproduced after a process restart. So the submission always carries the messageExcerpt body snapshot — that is the
 * only reliable basis for tracing back; the id is just a clue, used by the "submitted" marker for dedupe matching within the current session.
 */
export default function FeedbackActions({ threadId }: { threadId: string }) {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const queryClient = useQueryClient();
  const message = useAuiState((s) => s.message);
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState('');

  const queryKey = ['assistant', 'feedback', threadId];
  const { data: mine } = useQuery({
    queryKey,
    queryFn: () => api.assistant.feedback.mine(threadId),
    // Feedback is a personal marker; re-fetch on thread switch is enough. Excluded from refetch-on-focus to avoid pointless polling.
    staleTime: 30_000,
  });
  const submitted = mine?.find((f) => f.messageAnchor === message.id);

  const submit = useMutation({
    mutationFn: (v: { sentiment: 'positive' | 'negative'; comment?: string }) =>
      api.assistant.feedback.create({
        threadId,
        sentiment: v.sentiment,
        comment: v.comment,
        messageAnchor: message.id,
        messageIndex: message.index,
        messageExcerpt: excerptOf(message.parts),
        messageAt: message.createdAt ? new Date(message.createdAt).toISOString() : undefined,
      }),
    onSuccess: (_r, v) => {
      toast(t(v.sentiment === 'positive' ? 'assistant:feedback.submittedPositive' : 'assistant:feedback.submittedNegative'), 'success');
      setOpen(false);
      setComment('');
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (e: Error) => toast(localizeApiError(e) || t('assistant:feedback.submitFailed'), 'error'),
  });

  if (submitted) {
    return (
      <div className="mt-1.5 flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--muted-foreground)' }}
        title={t('assistant:feedback.submitted')}>
        <span style={{ color: 'var(--primary)' }}>
          {submitted.sentiment === 'positive' ? <ThumbUp filled /> : <ThumbDown filled />}
        </span>
        <span>
          {t(submitted.sentiment === 'positive' ? 'assistant:feedback.submittedPositive' : 'assistant:feedback.submittedNegative')}
        </span>
      </div>
    );
  }

  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          aria-label={t('assistant:feedback.positive')}
          title={t('assistant:feedback.positive')}
          disabled={submit.isPending}
          onClick={() => submit.mutate({ sentiment: 'positive' })}
          className="btn-tint rounded p-1 disabled:opacity-50"
          style={{ color: 'var(--muted-foreground)' }}
        >
          <ThumbUp filled={false} />
        </button>
        <button
          type="button"
          aria-label={t('assistant:feedback.negative')}
          title={t('assistant:feedback.negative')}
          disabled={submit.isPending}
          onClick={() => setOpen((v) => !v)}
          className="btn-tint rounded p-1 disabled:opacity-50"
          style={{ color: 'var(--muted-foreground)' }}
        >
          <ThumbDown filled={false} />
        </button>
      </div>

      {open && (
        <div className="mt-1.5 flex flex-col gap-1.5">
          <textarea
            autoFocus
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={t('assistant:feedback.commentPlaceholder')}
            rows={2}
            // Purely local input: the whole conversation lives under one origin, so autocomplete/autocorrect/spellcheck are off,
            // otherwise the browser would red-squiggle "you picked the wrong locator here" as a person's name and interfere with typing.
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="w-full resize-none rounded-[var(--radius-sm)] px-2 py-1.5 text-[12px]"
            style={{
              border: '1px solid var(--border)',
              background: 'var(--background)',
              color: 'var(--foreground)',
            }}
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn-tint rounded-md px-2.5 py-1 text-[12px]"
              style={{ border: '1px solid var(--border)', color: 'var(--muted-foreground)' }}
              onClick={() => { setOpen(false); setComment(''); }}
            >
              {t('assistant:feedback.cancel')}
            </button>
            <button
              type="button"
              className="btn-feedback rounded-md px-2.5 py-1 text-[12px] text-white disabled:opacity-50"
              style={{ background: 'var(--primary)' }}
              disabled={submit.isPending}
              onClick={() => submit.mutate({ sentiment: 'negative', comment: comment.trim() || undefined })}
            >
              {t('assistant:feedback.submit')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
