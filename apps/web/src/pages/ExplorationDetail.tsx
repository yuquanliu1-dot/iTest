import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { EXPLORATION_PERSONAS } from '@itest/shared';
import { localizeApiError } from '../i18n';
import { api, type ExplorationFinding } from '../api/client';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import StatusPill from '../components/ui/StatusPill';
import PriorityBadge from '../components/ui/PriorityBadge';
import LiveViewCard from '../components/LiveViewCard';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/Modal';
import { fullDateTime } from '../lib/format';
import { creatorName } from '../lib/creatorName';

/** 人格文案：单一真源在 @itest/shared（labelZh/labelEn），此处按当前语言取一侧。 */
function personaLabel(key: string, lang: string): string {
  const p = EXPLORATION_PERSONAS.find((x) => x.key === key);
  if (!p) return key;
  return lang.startsWith('en') ? p.labelEn : p.labelZh;
}

/** 证据截图：/screenshots/<sessionId>/finding-<order>.png，由 express.static 提供。 */
function screenshotUrl(path: string | null): string | null {
  if (!path) return null;
  return path.startsWith('/') ? path : `/${path}`;
}

export default function ExplorationDetail() {
  const { id, projectId, versionId } = useParams<{ id: string; projectId: string; versionId: string }>();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();

  const { data: session, isLoading, isError, error } = useQuery({
    queryKey: ['exploration', id],
    queryFn: () => api.explorations.get(id!),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 2000 : false),
  });

  const findings = session?.findings ?? [];

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['exploration', id] });
    qc.invalidateQueries({ queryKey: ['explorations'] });
  };

  const cancel = useMutation({
    mutationFn: () => api.explorations.cancel(id!),
    onSuccess: () => {
      toast(t('explorations:cancelRequested'), 'success');
      invalidate();
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const remove = useMutation({
    mutationFn: () => api.explorations.remove(id!),
    onSuccess: () => {
      toast(t('explorations:deletedToast'), 'success');
      qc.invalidateQueries({ queryKey: ['explorations'] });
      navigate(`/p/${projectId}/v/${versionId}/explorations`);
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const review = useMutation({
    mutationFn: (v: { findingId: string; decision: 'confirmed' | 'dismissed' }) =>
      api.explorations.review(id!, v.findingId, v.decision),
    onSuccess: invalidate,
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  // ── 升格为用例：先选目标分组 ──────────────────────────────────────────
  const [promoteTarget, setPromoteTarget] = useState<ExplorationFinding | null>(null);
  const [groupId, setGroupId] = useState('');
  const { data: groups } = useQuery({
    queryKey: ['groups', projectId, versionId],
    queryFn: () => api.projects.groups(projectId!),
    enabled: !!promoteTarget && !!projectId && !!versionId,
  });
  const promote = useMutation({
    mutationFn: () =>
      api.explorations.promote(id!, promoteTarget!.id, { groupId }),
    onSuccess: () => {
      toast(t('explorations:promoteSuccess'), 'success');
      setPromoteTarget(null);
      setGroupId('');
      invalidate();
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  // 证据截图放大
  const [zoom, setZoom] = useState<string | null>(null);

  if (isError) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--muted-foreground)', fontSize: 13 }}>
        {t('common:loadFailed')}：{error?.message ?? t('common:unknownError')}
      </div>
    );
  }

  if (isLoading || !session) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--muted-foreground)' }}>
        <Icon name="loader" size={16} className="animate-spin" />
        <span style={{ marginLeft: 8 }}>{t('cases:loading')}</span>
      </div>
    );
  }

  const running = session.status === 'running' || session.status === 'pending';

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 px-6 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <Button variant="ghost" size="sm" onClick={() => navigate(`/p/${projectId}/v/${versionId}/explorations`)}>
          <Icon name="chevronLeft" size={12} />
          {t('explorations:backToList')}
        </Button>
        <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
        <h1 className="text-[16px] font-semibold truncate" style={{ color: 'var(--foreground)' }}>
          {session.title || t('explorations:emptySession')}
        </h1>
        <StatusPill status={session.status} pulse={session.status === 'running'}>
          {t(`cases:status.${session.status}`)}
        </StatusPill>
        <div className="flex-1" />
        {running && (
          <Button variant="ghost" onClick={() => cancel.mutate()} disabled={cancel.isPending || session.cancelRequested}>
            <Icon name="pause" size={12} />
            {session.cancelRequested ? t('explorations:cancelRequested') : t('explorations:cancel')}
          </Button>
        )}
        {(!running || session.cancelRequested) && (
          <Button
            variant="ghost"
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
            style={{ color: 'var(--destructive)' }}
            aria-label={t('explorations:deleteSession')}
            title={t('explorations:deleteSession')}
          >
            <Icon name="trash" size={12} />
          </Button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6 flex flex-col gap-4">
        {/* 实时画面：running 走 MJPEG 实时流；结束后定格 + 回放（同计划运行）。 */}
        <div className="shrink-0">
          <LiveViewCard
            liveUrl={api.explorations.liveUrl(session.id)}
            replayUrl={(speed) => api.explorations.replayUrl(session.id, speed)}
            replayMetaUrl={api.explorations.replayMetaUrl(session.id)}
            running={session.status === 'running'}
          />
        </div>

        {session.error && (
          <div
            className="shrink-0 text-[12px] px-3 py-2 rounded-[var(--radius-sm)]"
            style={{ background: 'var(--destructive-soft-strong)', color: 'var(--destructive)' }}
          >
            {session.error}
          </div>
        )}
        {session.summary && (
          <div className="shrink-0 bg-card border rounded-[var(--radius-md)] p-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
            {session.summary}
          </div>
        )}

        {/* 章程与运行元信息 */}
        <div className="shrink-0 bg-card border rounded-[var(--radius-md)] p-4 flex flex-col gap-2">
          <div className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--muted-foreground)' }}>
            {t('explorations:charterTitle')}
          </div>
          <div className="text-[13px]" style={{ color: 'var(--foreground)' }}>{session.charter}</div>
          <div className="text-[11px] mt-1 flex items-center gap-3 flex-wrap" style={{ color: 'var(--muted-foreground)' }}>
            <span>{t('explorations:personaLabel')}：{personaLabel(session.persona, i18n.language)}</span>
            <span>{t('explorations:turnsUsed')}：{session.turnsUsed}</span>
            {session.startUrl && <span className="truncate max-w-[320px]">{session.startUrl}</span>}
            <span>{t('explorations:createdBy')}：{creatorName(session.createdBy)}</span>
            <span>{fullDateTime(session.createdAt)}</span>
            {session.finishedAt && <span>{t('explorations:finishedAt')}：{fullDateTime(session.finishedAt)}</span>}
            {session.usage?.calls != null && (
              <span>
                {t('explorations:usage')}：{session.usage.calls} {t('explorations:usageCalls')}
                {session.usage.promptTokens != null &&
                  ` · ${session.usage.promptTokens + (session.usage.completionTokens ?? 0)} ${t('explorations:usageTokens')}`}
              </span>
            )}
          </div>
        </div>

        {/* 缺陷候选：每条一张全宽卡片 */}
        <div className="shrink-0 flex flex-col gap-3">
          <div className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--muted-foreground)' }}>
            {t('explorations:findings')}（{findings.length}）
          </div>
          {findings.length === 0 ? (
            <div className="bg-card border rounded-[var(--radius-md)] overflow-hidden">
              <EmptyState icon="search" title={t('explorations:noFindings')} description={t('explorations:noFindingsHint')} />
            </div>
          ) : (
            findings.map((f) => {
              const img = screenshotUrl(f.screenshotPath);
              const steps = f.reproSteps ?? [];
              return (
                <div key={f.id} className="bg-card border rounded-[var(--radius-md)] p-4 flex flex-col gap-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <PriorityBadge priority={f.severity} />
                    <span className="text-[14px] font-semibold truncate" style={{ color: 'var(--foreground)' }} title={f.title}>
                      {f.title}
                    </span>
                    <StatusPill status={f.status === 'promoted' ? 'passed' : f.status === 'confirmed' ? 'passed' : f.status === 'dismissed' ? 'draft' : 'pending'}>
                      {t(`explorations:findingStatus.${f.status}`)}
                    </StatusPill>
                  </div>
                  <div className="text-[13px] whitespace-pre-wrap" style={{ color: 'var(--muted-foreground)' }}>
                    {f.description}
                  </div>

                  {steps.length > 0 && (
                    <div className="flex flex-col gap-1">
                      <div className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--muted-foreground)' }}>
                        {t('explorations:reproSteps')}
                      </div>
                      <ol className="text-[13px] list-decimal pl-5 flex flex-col gap-0.5" style={{ color: 'var(--foreground)' }}>
                        {steps.map((s, i) => (
                          <li key={i}>
                            {s.action}
                            {s.expected ? <span style={{ color: 'var(--muted-foreground)' }}> → {s.expected}</span> : null}
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}

                  {f.pageUrl && (
                    <div className="text-[11px] truncate" style={{ color: 'var(--muted-foreground)' }}>
                      {t('explorations:pageUrl')}：{f.pageUrl}
                    </div>
                  )}

                  {img ? (
                    <button
                      type="button"
                      onClick={() => setZoom(img)}
                      className="self-start"
                      title={t('explorations:zoomImage')}
                      style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden', lineHeight: 0 }}
                    >
                      <img src={img} alt={f.title} style={{ maxHeight: 180, display: 'block' }} />
                    </button>
                  ) : (
                    <div className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                      {t('explorations:noEvidence')}
                    </div>
                  )}

                  <div className="flex items-center gap-2">
                    {f.status === 'pending' && (
                      <>
                        <Button size="sm" disabled={review.isPending} onClick={() => review.mutate({ findingId: f.id, decision: 'confirmed' })}>
                          {t('explorations:confirmFinding')}
                        </Button>
                        <Button size="sm" variant="ghost" disabled={review.isPending} onClick={() => review.mutate({ findingId: f.id, decision: 'dismissed' })}>
                          {t('explorations:dismissFinding')}
                        </Button>
                      </>
                    )}
                    {f.status === 'confirmed' && (
                      <Button
                        size="sm"
                        disabled={promote.isPending}
                        onClick={() => {
                          setPromoteTarget(f);
                          setGroupId('');
                        }}
                      >
                        <Icon name="beaker" size={12} />
                        {t('explorations:promote')}
                      </Button>
                    )}
                    {f.status === 'promoted' && f.promotedCaseId && (
                      <Button size="sm" variant="ghost" onClick={() => navigate(`/p/${projectId}/v/${versionId}/cases/${f.promotedCaseId}`)}>
                        {t('explorations:promoteCaseLink')}
                        <Icon name="chevronRight" size={12} />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* 升格为用例：选分组 */}
      <Dialog open={!!promoteTarget} onOpenChange={(open) => { if (!open) setPromoteTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('explorations:promoteTitle')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <div className="text-[13px]" style={{ color: 'var(--foreground)' }}>
              {promoteTarget?.title}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-foreground)' }}>
                {t('explorations:group')}
              </label>
              {groups && groups.length > 0 ? (
                <select className="input-base" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                  <option value="">{t('explorations:groupPlaceholder')}</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              ) : (
                <span className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
                  {t('explorations:noGroups')}
                </span>
              )}
            </div>
            <div className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
              {t('explorations:promoteHint')}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPromoteTarget(null)}>{t('common:cancel')}</Button>
            <Button disabled={!groupId || promote.isPending} onClick={() => promote.mutate()}>
              {promote.isPending ? t('common:loading') : t('explorations:promoteConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 证据截图放大 */}
      <Dialog open={!!zoom} onOpenChange={(open) => { if (!open) setZoom(null); }}>
        <DialogContent style={{ maxWidth: 900 }}>
          {zoom && <img src={zoom} alt={t('explorations:zoomImage')} style={{ width: '100%', display: 'block' }} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
