import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import Icon from '../Icon';
import EmptyState from '../ui/EmptyState';

/**
 * Settings page "user feedback" read-only list.
 *
 * Lives inside AssistantPanel rather than a standalone route: feedback belongs to the assistant domain anyway, is read-only with no
 * approval workflow, and doesn't merit its own sidebar slot. Split into a standalone page when approval/consumption actually happens.
 *
 * The list shows messageExcerpt (a body snapshot taken at submit time) instead of jumping into the original conversation — the thread
 * is in-memory state, unreachable from the UI after a process restart; the excerpt is the only reliable anchor for recovering context.
 */
const PAGE_SIZE = 20;

export default function FeedbackSection() {
  const { t } = useTranslation();
  const [sentiment, setSentiment] = useState('');
  const [projectId, setProjectId] = useState('');
  const [offset, setOffset] = useState(0);

  const projectsQ = useQuery({
    queryKey: ['assistant', 'feedback', 'projects'],
    queryFn: () => api.assistant.feedback.listProjects(),
    staleTime: 60_000,
  });
  const listQ = useQuery({
    queryKey: ['assistant', 'feedback', 'all', sentiment, projectId, offset],
    queryFn: () => api.assistant.feedback.listAll({
      sentiment: sentiment || undefined, projectId: projectId || undefined,
      limit: PAGE_SIZE, offset,
    }),
  });

  const total = listQ.data?.total ?? 0;
  const rows = listQ.data?.rows ?? [];
  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;

  return (
    <div className="bg-card border rounded-[var(--radius-sm)]">
      <div className="flex items-center gap-2 px-4 py-3 hairline-bottom" style={{ borderColor: 'var(--border)' }}>
        <Icon name="chat" size={14} style={{ color: 'var(--primary)' }} />
        <h3 className="text-[14px] font-semibold m-0 flex-1" style={{ color: 'var(--foreground)' }}>
          {t('settings:feedbackTitle')}
        </h3>
        <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
          {t('settings:feedbackTotal', { count: total })}
        </span>
      </div>
      <div className="px-4 pt-2 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
        {t('settings:feedbackIntro')}
      </div>

      {/* Filters: sentiment + project. Switching a filter always returns to page 1 — otherwise staying on page 3 with a new filter's results would come up empty. */}
      <div className="flex items-center gap-2 px-4 pt-3">
        <select
          value={sentiment}
          onChange={(e) => { setSentiment(e.target.value); setOffset(0); }}
          className="rounded-md px-2 py-1 text-[12px]"
          style={{ border: '1px solid var(--border)', background: 'var(--background)', color: 'var(--foreground)' }}
        >
          <option value="">{t('settings:feedbackAll')}</option>
          <option value="positive">{t('settings:feedbackPositive')}</option>
          <option value="negative">{t('settings:feedbackNegative')}</option>
        </select>
        <select
          value={projectId}
          onChange={(e) => { setProjectId(e.target.value); setOffset(0); }}
          className="rounded-md px-2 py-1 text-[12px]"
          style={{ border: '1px solid var(--border)', background: 'var(--background)', color: 'var(--foreground)' }}
        >
          <option value="">{t('settings:feedbackAllProjects')}</option>
          {(projectsQ.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      <div className="p-2">
        {listQ.isLoading ? (
          <div className="flex items-center gap-2 px-2 py-4 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
            <Icon name="loader" size={14} className="animate-spin" />
            {t('common:loading')}
          </div>
        ) : listQ.isError ? (
          <div className="px-2 py-4 text-[12px]" style={{ color: 'var(--destructive)' }}>
            {t('settings:feedbackLoadFailed')}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon="chat" title={t('settings:feedbackNone')} compact />
        ) : (
          rows.map((f) => (
            <div key={f.id} className="px-2 py-2.5" style={{ borderTop: '1px solid var(--border)' }}>
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className="text-[10px] px-1.5 py-[1px] rounded shrink-0"
                  style={f.sentiment === 'positive'
                    ? { background: 'var(--primary-soft)', color: 'var(--primary)' }
                    : { background: 'var(--destructive-soft)', color: 'var(--destructive)' }}
                >
                  {f.sentiment === 'positive' ? t('settings:feedbackPositive') : t('settings:feedbackNegative')}
                </span>
                <span className="text-[12px] font-medium" style={{ color: 'var(--foreground)' }}>
                  {f.authorName ?? t('settings:feedbackAnonymous')}
                </span>
                <span className="text-[11px] ml-auto shrink-0" style={{ color: 'var(--muted-foreground)' }}>
                  {f.createdAt ? new Date(f.createdAt).toLocaleString() : ''}
                </span>
              </div>
              {/* The user's comment first (verbatim, priority), with the original reply excerpt as context below. */}
              <div className="text-[12px] mt-1.5" style={{ color: 'var(--foreground)' }}>
                {f.comment || t('settings:feedbackNoComment')}
              </div>
              {f.messageExcerpt && (
                <details className="mt-1">
                  <summary className="text-[11px] cursor-pointer" style={{ color: 'var(--muted-foreground)' }}>
                    {t('settings:feedbackOnReply')}
                  </summary>
                  <p className="text-[11px] whitespace-pre-wrap break-words max-h-32 overflow-y-auto mt-1"
                    style={{ color: 'var(--muted-foreground)' }}>
                    {f.messageExcerpt}
                  </p>
                </details>
              )}
            </div>
          ))
        )}
      </div>

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between px-4 py-2.5" style={{ borderTop: '1px solid var(--border)' }}>
          <button
            type="button"
            className="rounded-md px-2.5 py-1 text-[12px] disabled:opacity-40"
            style={{ border: '1px solid var(--border)', color: 'var(--muted-foreground)', background: 'transparent' }}
            disabled={!canPrev}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            {t('settings:feedbackPrev')}
          </button>
          <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
            {Math.floor(offset / PAGE_SIZE) + 1} / {Math.ceil(total / PAGE_SIZE)}
          </span>
          <button
            type="button"
            className="rounded-md px-2.5 py-1 text-[12px] disabled:opacity-40"
            style={{ border: '1px solid var(--border)', color: 'var(--muted-foreground)', background: 'transparent' }}
            disabled={!canNext}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            {t('settings:feedbackNext')}
          </button>
        </div>
      )}
    </div>
  );
}
