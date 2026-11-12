/**
 * Persona matrix view (C3/S2): spin up N persona sessions on the same charter running in parallel (grouped by the same matrix_id).
 * Top half: per-session cards (persona/status/finding count, polling while running); bottom half: all matrix findings —
 * cross_session_count ≥2 = jointly discovered from multiple perspectives (S2 intersection mark, recomputed at wrap-up).
 */
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { EXPLORATION_PERSONAS } from '@itest/shared';
import { localizeApiError } from '../i18n';
import { api } from '../api/client';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import StatusPill from '../components/ui/StatusPill';
import PriorityBadge from '../components/ui/PriorityBadge';
import { fullDateTime } from '../lib/format';
import { creatorName } from '../lib/creatorName';

function personaLabel(key: string, lang: string): string {
  const p = EXPLORATION_PERSONAS.find((x) => x.key === key);
  if (!p) return key;
  return lang.startsWith('en') ? p.labelEn : p.labelZh;
}

export default function ExplorationMatrix() {
  const { matrixId, projectId, versionId } = useParams<{ matrixId: string; projectId: string; versionId: string }>();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['explorationMatrix', matrixId],
    queryFn: () => api.explorations.getMatrix(matrixId!),
    enabled: !!matrixId,
    // Poll while any session is still pending/running; stop once all are terminal.
    refetchInterval: (q) =>
      q.state.data?.sessions.some((s) => s.status === 'running' || s.status === 'pending') ? 2000 : false,
  });

  const cancelAll = useMutation({
    mutationFn: () => api.explorations.cancelMatrix(matrixId!),
    onSuccess: () => {
      toast(t('explorations:cancelRequested'), 'success');
      qc.invalidateQueries({ queryKey: ['explorationMatrix', matrixId] });
      qc.invalidateQueries({ queryKey: ['explorations'] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  if (isError) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--muted-foreground)', fontSize: 13 }}>
        {t('common:loadFailed')}：{error?.message ?? t('common:unknownError')}
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--muted-foreground)' }}>
        <Icon name="loader" size={16} className="animate-spin" />
        <span style={{ marginLeft: 8 }}>{t('cases:loading')}</span>
      </div>
    );
  }

  const live = data.sessions.some((s) => s.status === 'running' || s.status === 'pending');
  // Each session's finding count is computed from the matrix findings list (the API does not hand it back redundantly).
  const countBySession = new Map<string, number>();
  for (const f of data.findings) countBySession.set(f.sessionId, (countBySession.get(f.sessionId) ?? 0) + 1);
  const sessionById = new Map(data.sessions.map((s) => [s.id, s]));

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 px-6 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <Button variant="ghost" size="sm" onClick={() => navigate(`/p/${projectId}/v/${versionId}/explorations`)}>
          <Icon name="chevronLeft" size={12} />
          {t('explorations:backToList')}
        </Button>
        <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
        <h1 className="text-[16px] font-semibold truncate" style={{ color: 'var(--foreground)' }}>
          {data.label || t('explorations:newMatrix')}
        </h1>
        <span className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
          {t('explorations:matrixSessionsCount', { count: data.sessions.length })}
        </span>
        <div className="flex-1" />
        {live && (
          <Button variant="ghost" onClick={() => cancelAll.mutate()} disabled={cancelAll.isPending}>
            <Icon name="pause" size={12} />
            {t('explorations:matrixCancelAll')}
          </Button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6 flex flex-col gap-4">
        {/* Per session: persona/status/finding count; click a card to enter the detail for the process and review */}
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
          {data.sessions.map((s) => (
            <div
              key={s.id}
              onClick={() => navigate(`/p/${projectId}/v/${versionId}/explorations/${s.id}`)}
              className="bg-card border rounded-[var(--radius-md)] p-4 cursor-pointer hover-card flex flex-col gap-2"
            >
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-semibold" style={{ color: 'var(--foreground)' }}>
                  {personaLabel(s.matrixRole || s.persona, i18n.language)}
                </span>
                <StatusPill status={s.status} pulse={s.status === 'running'}>
                  {t(`cases:status.${s.status}`)}
                </StatusPill>
                <div className="flex-1" />
                <Icon name="chevronRight" size={12} />
              </div>
              <div className="text-[11px] flex items-center gap-2 flex-wrap" style={{ color: 'var(--muted-foreground)' }}>
                <span>
                  {t('explorations:findings')}：{countBySession.get(s.id) ?? 0}
                </span>
                <span>·</span>
                <span>{creatorName(s.createdBy)}</span>
                <span>·</span>
                <span>{fullDateTime(s.createdAt)}</span>
              </div>
              {s.summary && (
                <div className="text-[12px] line-clamp-2" style={{ color: 'var(--muted-foreground)' }}>
                  {s.summary}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Matrix findings: intersection ≥2 marked "discovered from multiple perspectives" — multiple personas independently hitting the same defect is more credible than a single report */}
        <div className="flex flex-col gap-3">
          <div className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--muted-foreground)' }}>
            {t('explorations:findings')}（{data.findings.length}）
          </div>
          {data.findings.length === 0 ? (
            <div className="bg-card border rounded-[var(--radius-md)] overflow-hidden">
              <EmptyState icon="search" title={t('explorations:noFindings')} description={t('explorations:noFindingsHint')} />
            </div>
          ) : (
            data.findings.map((f) => {
              const src = sessionById.get(f.sessionId);
              const multi = f.crossSessionCount >= 2;
              return (
                <div key={f.id} className="bg-card border rounded-[var(--radius-md)] p-4 flex flex-col gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <PriorityBadge priority={f.severity} />
                    <span className="text-[14px] font-semibold" style={{ color: 'var(--foreground)' }}>
                      {f.title}
                    </span>
                    {multi && (
                      <span
                        className="px-1.5 py-0.5 rounded text-[11px]"
                        style={{ background: 'var(--primary-soft, var(--muted))', color: 'var(--primary)' }}
                        title={t('explorations:multiViewHint')}
                      >
                        {t('explorations:multiViewTag', { count: f.crossSessionCount })}
                      </span>
                    )}
                    {src && (
                      <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                        {personaLabel(src.matrixRole || src.persona, i18n.language)}
                      </span>
                    )}
                  </div>
                  <div className="text-[13px] whitespace-pre-wrap" style={{ color: 'var(--muted-foreground)' }}>
                    {f.description}
                  </div>
                  {f.judge && (
                    <div className="text-[11px]" style={{ color: 'var(--muted-foreground)' }} title={f.judge.reason}>
                      {t('explorations:judgeLabel')}：
                      {t(`explorations:judgeVerdict.${f.judge.verdict}`)}
                      {` · ${Math.round(f.judge.confidence * 100)}%`}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
