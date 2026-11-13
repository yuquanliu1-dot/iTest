import { useEffect, useRef, useState } from 'react';
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

/** Persona copy: single source of truth in @itest/shared (labelZh/labelEn); this picks one side by the current language. */
function personaLabel(key: string, lang: string): string {
  const p = EXPLORATION_PERSONAS.find((x) => x.key === key);
  if (!p) return key;
  return lang.startsWith('en') ? p.labelEn : p.labelZh;
}

/** Evidence screenshots: /screenshots/<sessionId>/finding-<order>.png, served by express.static. */
function screenshotUrl(path: string | null): string | null {
  if (!path) return null;
  return path.startsWith('/') ? path : `/${path}`;
}

/** Trail text clamp: evaluate's JSON spread raw is the main noise in the trail card; truncate when too long + inline expand. */
const STEP_TEXT_CLAMP = 140;

/** URL → path (returns the input as-is when unparseable). */
function pathOf(u: string): string {
  try {
    return new URL(u).pathname;
  } catch {
    return u;
  }
}

/**
 * Navigate landing check: outcome is always "已打开 <page.url()>" (tool-layer contract, browser.ts).
 * target's path ≠ actual path = SPA redirect/fallback (navigation defeated) — the key event behind "why it came back empty-handed".
 * Not judged when target is the root path (login redirects happen every session; the badge would fatigue).
 */
function navLandedMismatch(step: { type: string; ok: boolean; target?: string; outcome?: string }): string | null {
  if (step.type !== 'navigate' || !step.ok || !step.target) return null;
  const m = step.outcome?.match(/^已打开\s+(\S+)/);
  if (!m) return null;
  const targetPath = pathOf(step.target);
  const landedPath = pathOf(m[1]!);
  if (targetPath === landedPath || targetPath === '/') return null;
  return landedPath;
}

/** Code-scope file grouping (mechanically by extension): the group header answers in one line "which parts changed and by how much". */
type FileGroupKey = 'sql' | 'java' | 'frontend' | 'other';
function fileGroupOf(path: string): FileGroupKey {
  const p = path.toLowerCase();
  if (p.endsWith('.sql')) return 'sql';
  if (p.endsWith('.java')) return 'java';
  if (/\.(?:vue|js|ts|jsx|tsx|css|scss|less|html)$/.test(p)) return 'frontend';
  return 'other';
}
const FILE_GROUP_ORDER: FileGroupKey[] = ['sql', 'java', 'frontend', 'other'];

/** Change-type badge color: A=added / D=deleted / M=modified. */
function fileStatusColor(status: string): string {
  if (status === 'A') return 'var(--success)';
  if (status === 'D') return 'var(--destructive)';
  return 'var(--muted-foreground)';
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
    // Poll during pending too: a session is queued when first created; without polling the page would stay on pending forever
    // (it would never learn that it started running, and there would be no "session trail" to watch). Stops at terminal states.
    refetchInterval: (q) =>
      q.state.data?.status === 'running' || q.state.data?.status === 'pending' ? 2000 : false,
  });

  const findings = session?.findings ?? [];
  const steps = session?.steps ?? [];
  const excluded = session?.excludedLedger ?? [];
  const codeScope = session?.codeScope ?? null;
  const coverage = session?.coverageLedger ?? null;
  const errorSignals = session?.errorSignals ?? [];
  const fileGroups = (() => {
    const files = session?.codeScope?.files ?? [];
    const by = new Map<FileGroupKey, typeof files>();
    for (const f of files) {
      const k = fileGroupOf(f.path);
      const arr = by.get(k) ?? [];
      arr.push(f);
      by.set(k, arr);
    }
    return FILE_GROUP_ORDER.filter((k) => by.has(k)).map((k) => ({ key: k, files: by.get(k)! }));
  })();

  // Whether the picture is present (a frame to view): LiveViewImg reports true on mount, false when the stream drops/the frame is removed or unmounted (including session switches)
  // (recordings live only in server memory with a 30min TTL; after expiry there is no frame on replay and the session trail falls back to the full-width card).
  // Resetting on session switch is handled by the unmount cleanup; the page does not zero it itself (the parent effect runs after the child's and would swallow the report).
  const [hasLiveFrame, setHasLiveFrame] = useState(false);
  // Adaptive picture height: LiveViewImg scales its height proportionally to the column width (zero padding/zero cropping inside the frame) and reports the actual rendered height up,
  // the session trail card takes the same height → both panes share the same top edge and stay bottom-aligned; 220 is only the fallback before the first frame loads.
  const [liveH, setLiveH] = useState(220);
  // Trail card long-text expansion (key = o<index>/d<index>) and code-scope group collapse (key = group name; default = collapsed when the group has >8 files).
  const [expandedText, setExpandedText] = useState<Record<string, boolean>>({});
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  // Session trail auto-scroll: stick to the bottom as new steps arrive while running; stepsStick records whether the user is "watching the bottom" —
  // scrolling up pauses, scrolling back to the bottom resumes (see the onScroll on stepsBody and the effect below).
  const stepsListRef = useRef<HTMLOListElement | null>(null);
  const stepsStickRef = useRef(true);
  // Whether the session is live (pending counts): auto-scroll only serves the "watching a running session" scenario;
  // a terminal session is history the user reads top-down, so scrolling is not hijacked. Computed before the early-return branch (hooks cannot come after it).
  const sessionLive = session?.status === 'running' || session?.status === 'pending';

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

  // Rerun with this charter: auto-resume would need to restore LLM history/browser context/page stack — out of scope for this batch;
  // giving terminal sessions a same-charter restart entry beats making users copy the charter by hand.
  const rerun = useMutation({
    mutationFn: () =>
      api.explorations.create({
        versionId: versionId!,
        charter: session!.charter,
        persona: session!.persona,
        allowDestructive: session!.allowDestructive,
        allowFaultInjection: session!.allowFaultInjection,
        ...(session!.startUrl ? { startUrl: session!.startUrl } : {}),
        ...(session!.windowWidth && session!.windowHeight
          ? { windowWidth: session!.windowWidth, windowHeight: session!.windowHeight }
          : {}),
      }),
    onSuccess: (s) => {
      toast(t('explorations:rerunCreated'), 'success');
      qc.invalidateQueries({ queryKey: ['explorations'] });
      navigate(`/p/${projectId}/v/${versionId}/explorations/${s.id}`);
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  // ── Promote to case: pick the target group first ──────────────────────────────────────────
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

  // Evidence screenshot zoom
  const [zoom, setZoom] = useState<string | null>(null);

  /** One line of trail text: clamped beyond STEP_TEXT_CLAMP + inline expand/collapse (long JSON no longer spread raw). */
  const clampedLine = (text: string, mono: boolean, color: string, key: string) => {
    const open = !!expandedText[key];
    const tooLong = text.length > STEP_TEXT_CLAMP;
    return (
      <div className={`${mono ? 'font-mono text-[11px] break-all' : 'text-[11px] break-words'} pl-[76px]`} style={{ color }}>
        {tooLong && !open ? `${text.slice(0, STEP_TEXT_CLAMP)}…` : text}
        {tooLong && (
          <button
            type="button"
            className="ml-1 underline underline-offset-2"
            style={{ color: 'var(--primary)' }}
            onClick={() => setExpandedText((m) => ({ ...m, [key]: !m[key] }))}
          >
            {t(open ? 'explorations:collapse' : 'explorations:expand')}
          </button>
        )}
      </div>
    );
  };

  // Session trail: the side-by-side (right rail) and full-width layouts share the same header/list
  const stepsHeader = (
    <div className="flex items-baseline gap-2 shrink-0">
      <div className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--muted-foreground)' }}>
        {t('explorations:sessionSteps')}
      </div>
      <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{steps.length}</span>
    </div>
  );
  const stepsBody = (
    <ol
      ref={stepsListRef}
      onScroll={() => {
        const el = stepsListRef.current;
        if (!el) return;
        // Within 24px of the bottom counts as "at the bottom": auto-scroll keeps setting stick back to true; scrolling up sets it false to pause.
        stepsStickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="flex flex-col gap-1 overflow-y-auto min-h-0 flex-1"
    >
      {steps.map((s, i) => {
        const navLanded = navLandedMismatch(s);
        return (
          <li key={i} className="flex flex-col gap-0.5">
            <div className="flex items-start gap-2 text-[12px]">
              <span className="font-mono shrink-0" style={{ color: 'var(--muted-foreground)' }}>
                {String(i + 1).padStart(2, '0')}
              </span>
              <span
                className="shrink-0 px-1 rounded text-[11px]"
                style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}
              >
                {t(`explorations:actionTypes.${s.type}`, { defaultValue: s.type })}
              </span>
              {/* No empty placeholder when target is "-" (actions without a locate target, like observe/in-page scripts) */}
              {s.target && s.target !== '-' ? (
                <span className="font-mono break-all flex-1" style={{ color: 'var(--foreground)' }}>
                  {s.target}
                </span>
              ) : (
                <span className="flex-1" />
              )}
              <span className="shrink-0" style={{ color: s.ok ? 'var(--success)' : 'var(--destructive)' }}>
                {s.ok ? t('explorations:stepOk') : t('explorations:stepFail')}
              </span>
            </div>
            {/* Navigate landing check: target path ≠ actual path (SPA redirect/fallback) → amber highlight instead of drowning in gray text */}
            {navLanded ? (
              <div className="text-[11px] flex items-center gap-1 pl-[76px]" style={{ color: 'var(--warning)' }}>
                <Icon name="warning" size={11} className="shrink-0" />
                <span>{t('explorations:landedMismatch', { path: navLanded })}</span>
              </div>
            ) : (
              s.outcome && clampedLine(s.outcome, false, s.ok ? 'var(--muted-foreground)' : 'var(--destructive)', `o${i}`)
            )}
            {s.detail && clampedLine(s.detail, true, 'var(--muted-foreground)', `d${i}`)}
          </li>
        );
      })}
    </ol>
  );

  // New steps arriving while running → auto-stick to the bottom. hasLiveFrame is in deps: switching side-by-side↔full-width remounts the <ol>
  // (scrollTop resets to 0), so it must re-stick after switching. In full-width mode the <ol> does not scroll internally (the page scrolls), so setting scrollTop is a harmless no-op.
  useEffect(() => {
    if (!sessionLive) return;
    const el = stepsListRef.current;
    if (!el || !stepsStickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [steps.length, hasLiveFrame, sessionLive]);

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
        {/* Rerun entry only for terminal sessions: a running session is still writing findings; restarting would mean two sessions in parallel. */}
        {!running && (
          <Button variant="ghost" onClick={() => rerun.mutate()} disabled={rerun.isPending}>
            <Icon name="renew" size={12} />
            {t('explorations:rerun')}
          </Button>
        )}
        {(!running || session.cancelRequested) && (
          <>
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
          </>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6 flex flex-col gap-4">
        {/* Charter and run metadata: pinned to the top — read "what is being tested this time" first, then the picture and the trail. */}
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

        {/* Code commit scope: parsed from the charter's natural language (parsed by the runner in the background, visible via polling).
            Scope is a focus, not a fence — the card is directional reference only; none (charter unrelated to commit history) renders no card. */}
        {(session.codeScopeStatus === 'pending' || codeScope || session.codeScopeStatus === 'failed') && (
          <div className="shrink-0 bg-card border rounded-[var(--radius-md)] p-4 flex flex-col gap-2">
            <div className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--muted-foreground)' }}>
              {t('explorations:codeScopeTitle')}
            </div>
            {session.codeScopeStatus === 'pending' && !codeScope && (
              <div className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
                {t('explorations:codeScopeStatus.pending')}…
              </div>
            )}
            {session.codeScopeStatus === 'failed' && !codeScope && (
              <div className="text-[12px]" style={{ color: 'var(--destructive)' }}>
                {t('explorations:codeScopeStatus.failed')}
              </div>
            )}
            {codeScope && (
              <>
                <div className="text-[13px] font-medium" style={{ color: 'var(--foreground)' }}>
                  {codeScope.label}
                  <span className="ml-2 text-[11px] font-normal" style={{ color: 'var(--muted-foreground)' }}>
                    {codeScope.commits.length} {t('explorations:codeScopeCommits')} · {codeScope.files.length} {t('explorations:codeScopeFiles')}
                  </span>
                </div>
                {codeScope.commits.length > 0 && (
                  <div className="flex flex-col gap-0.5">
                    {codeScope.commits.slice(0, 10).map((c) => (
                      <div key={c.sha} className="text-[12px] font-mono truncate" title={c.subject}>
                        <span style={{ color: 'var(--muted-foreground)' }}>{c.sha.slice(0, 8)}</span>
                        <span className="mx-1" style={{ color: 'var(--muted-foreground)' }}>{c.date.slice(0, 10)}</span>
                        <span style={{ color: 'var(--foreground)' }}>{c.subject}</span>
                      </div>
                    ))}
                  </div>
                )}
                {/* Files rendered in full, grouped by type (SQL/Java/frontend/other): a silent slice once swallowed a +372 largest addition
                    beyond the first 20 entries; the group header answers "which parts changed and by how much", groups with >8 entries default to collapsed. */}
                {fileGroups.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    {fileGroups.map((g) => {
                      const add = g.files.reduce((n, f) => n + f.additions, 0);
                      const del = g.files.reduce((n, f) => n + f.deletions, 0);
                      const collapsed = collapsedGroups[g.key] ?? g.files.length > 8;
                      return (
                        <div key={g.key} className="flex flex-col gap-0.5">
                          <button
                            type="button"
                            className="flex items-center gap-1.5 text-left"
                            onClick={() => setCollapsedGroups((m) => ({ ...m, [g.key]: !collapsed }))}
                          >
                            <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={11} className="shrink-0" style={{ color: 'var(--muted-foreground)' }} />
                            <span className="text-[12px] font-medium" style={{ color: 'var(--foreground)' }}>
                              {t(`explorations:codeScopeGroup.${g.key}`)}
                            </span>
                            <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                              {g.files.length} {t('explorations:codeScopeFiles')}
                              {add > 0 && <span style={{ color: 'var(--success)' }}> ·+{add}</span>}
                              {del > 0 && <span style={{ color: 'var(--destructive)' }}> ·-{del}</span>}
                            </span>
                          </button>
                          {!collapsed && (
                            <div className="flex flex-col gap-0.5 pl-4">
                              {g.files.map((f) => (
                                <div key={f.path} className="text-[12px] font-mono flex items-baseline gap-2 min-w-0">
                                  <span
                                    className="shrink-0 px-1 rounded text-[10px]"
                                    title={t(`explorations:codeScopeFileStatus.${f.status}`, { defaultValue: f.status })}
                                    style={{ color: fileStatusColor(f.status), background: 'var(--muted)' }}
                                  >
                                    {f.status}
                                  </span>
                                  <span className="truncate flex-1" style={{ color: 'var(--foreground)' }} title={f.path}>{f.path}</span>
                                  <span className="shrink-0" style={{ color: 'var(--success)' }}>+{f.additions}</span>
                                  <span className="shrink-0" style={{ color: 'var(--destructive)' }}>-{f.deletions}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {codeScope.hintUrls.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <div className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('explorations:codeScopeHintUrls')}</div>
                    <div className="flex flex-wrap gap-1">
                      {codeScope.hintUrls.map((u) => (
                        <span key={u} className="px-1.5 py-0.5 rounded text-[11px] font-mono" style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}>{u}</span>
                      ))}
                    </div>
                  </div>
                )}
                {codeScope.reason && (
                  <div className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                    {t('explorations:codeScopeReason')}：{codeScope.reason}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Live picture + session trail side by side: both panes equal width (half each), bottom alignment preserved.
            Adaptive picture height: scaled proportionally to the column width (zero padding/zero cropping inside the frame); LiveViewImg reports the actual height to liveH;
            the session trail card's fixed height = picture frame height (liveH + 2px top/bottom borders) → both panes share the same top edge and stay bottom-aligned,
            with many steps they scroll inside the pane instead of stretching the page.
            The replay button row below the picture frame belongs "outside the window" and does not participate in alignment.
            Without a picture (recording past TTL / never ran / stream dropped) no side-by-side: blank on the right is dead space,
            so the session trail falls back to the full-width card (same as before the restyle). */}
        <div
          className="shrink-0 grid gap-4"
          style={{ gridTemplateColumns: steps.length > 0 && hasLiveFrame ? 'minmax(0, 1fr) minmax(0, 1fr)' : 'minmax(0, 1fr)' }}
        >
          <div className="min-w-0">
            <LiveViewCard
              liveUrl={api.explorations.liveUrl(session.id)}
              replayUrl={(speed) => api.explorations.replayUrl(session.id, speed)}
              replayMetaUrl={api.explorations.replayMetaUrl(session.id)}
              running={session.status === 'running'}
              onFrameHeightChange={setLiveH}
              onFrameVisibleChange={setHasLiveFrame}
            />
          </div>
          {steps.length > 0 &&
            (hasLiveFrame ? (
              <div
                className="min-w-0 flex flex-col gap-2 overflow-hidden bg-card border rounded-[var(--radius-md)] p-4"
                style={{ height: liveH + 2 }}
              >
                {stepsHeader}
                {stepsBody}
              </div>
            ) : (
              <div className="shrink-0 bg-card border rounded-[var(--radius-md)] p-4 flex flex-col gap-2">
                {stepsHeader}
                {stepsBody}
              </div>
            ))}
        </div>

        {/* Negative-result ledger: the model's declared "excluded hypotheses + evidence". Stores only exclusions, never beliefs —
            storing beliefs on the blackboard freezes observations into conclusions and self-confirms. */}
        {excluded.length > 0 && (
          <div className="shrink-0 bg-card border rounded-[var(--radius-md)] p-4 flex flex-col gap-2">
            <div className="flex items-baseline gap-2">
              <div className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--muted-foreground)' }}>
                {t('explorations:excludedTitle')}
              </div>
              <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{excluded.length}</span>
            </div>
            <ul className="flex flex-col gap-1.5">
              {excluded.map((e, i) => (
                <li key={i} className="flex flex-col gap-0.5">
                  <div className="flex items-start gap-2 text-[12px]">
                    <Icon name="check" size={12} className="shrink-0 mt-0.5" style={{ color: 'var(--success)' }} />
                    <span className="flex-1" style={{ color: 'var(--foreground)' }}>{e.claim}</span>
                  </div>
                  <div className="text-[11px] pl-6" style={{ color: 'var(--muted-foreground)' }}>
                    {t('explorations:excludedEvidence')}：{e.evidence}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Coverage ledger (C1): which pages were visited/which controls were touched/subgoal completion, mechanically maintained by the platform —
            answers "exploration coverage"; the model only reports subgoal completion, while paths and interactions are an objective aggregation of the action trail. */}
        {coverage && (coverage.paths.length > 0 || coverage.interactions.length > 0 || coverage.goals.length > 0) && (
          <div className="shrink-0 bg-card border rounded-[var(--radius-md)] p-4 flex flex-col gap-2">
            <div className="flex items-baseline gap-2">
              <div className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--muted-foreground)' }}>
                {t('explorations:coverageTitle')}
              </div>
              <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                {coverage.paths.length} {t('explorations:coveragePaths')}
              </span>
            </div>
            {coverage.paths.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {coverage.paths.slice(-20).map((p) => (
                  <span
                    key={p}
                    className="px-1.5 py-0.5 rounded text-[11px] font-mono truncate max-w-[360px]"
                    style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}
                    title={p}
                  >
                    {p}
                  </span>
                ))}
              </div>
            )}
            {coverage.interactions.length > 0 && (
              <div className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
                {t('explorations:coverageInteractions')}：
                {coverage.interactions.map((it) => `${it.kind}×${it.count}`).join('、')}
              </div>
            )}
            {coverage.goals.length > 0 && (
              <div className="flex flex-col gap-1">
                {coverage.goals.map((g) => (
                  <div key={g.id} className="flex items-start gap-2 text-[12px]">
                    <Icon
                      name={g.done ? 'check' : 'circleDot'}
                      size={12}
                      className="shrink-0 mt-0.5"
                      style={{ color: g.done ? 'var(--success)' : 'var(--muted-foreground)' }}
                    />
                    <span style={{ color: g.done ? 'var(--foreground)' : 'var(--muted-foreground)' }}>{g.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Error signals (D3): console/pageerror/HTTP 4xx-5xx the page itself produced during exploration —
            first-hand corroboration of defects, cross-checked against findings. */}
        {errorSignals.length > 0 && (
          <div className="shrink-0 bg-card border rounded-[var(--radius-md)] p-4 flex flex-col gap-2">
            <div className="flex items-baseline gap-2">
              <div className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--muted-foreground)' }}>
                {t('explorations:errorSignalsTitle')}
              </div>
              <span className="text-[11px]" style={{ color: 'var(--destructive)' }}>{errorSignals.length}</span>
            </div>
            <ul className="flex flex-col gap-1">
              {errorSignals.slice(-30).reverse().map((sig, i) => (
                <li key={i} className="font-mono text-[11px] break-all" style={{ color: 'var(--muted-foreground)' }}>
                  <span
                    className="px-1 rounded mr-1"
                    style={{ background: 'var(--muted)', color: sig.kind === 'http' ? 'var(--destructive)' : 'var(--muted-foreground)' }}
                  >
                    {sig.kind}
                  </span>
                  {sig.text}
                  {sig.url && <span className="ml-1 opacity-70">({sig.url})</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Defect candidates: one full-width card each */}
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
                    {/* Multi-view joint finding (S2): ≥2 persona sessions independently hit the same defect (near-duplicate matching), more credible than a single report. */}
                    {(f.crossSessionCount ?? 1) >= 2 && (
                      <span
                        className="px-1.5 py-0.5 rounded text-[11px]"
                        style={{ background: 'var(--primary-soft, var(--muted))', color: 'var(--primary)' }}
                        title={t('explorations:multiViewHint')}
                      >
                        {t('explorations:multiViewTag', { count: f.crossSessionCount })}
                      </span>
                    )}
                    {/* Independent review badge (A3): annotation only, no adjudication (human review is the authority); hover for the review reason. */}
                    {f.judge && (
                      <span
                        className="px-1.5 py-0.5 rounded text-[11px]"
                        title={f.judge.reason}
                        style={{
                          color:
                            f.judge.verdict === 'confirmed'
                              ? 'var(--success)'
                              : f.judge.verdict === 'dismissed'
                                ? 'var(--destructive)'
                                : 'var(--muted-foreground)',
                          background: 'var(--muted)',
                        }}
                      >
                        {t('explorations:judgeLabel')}：{t(`explorations:judgeVerdict.${f.judge.verdict}`)}
                        {` · ${Math.round(f.judge.confidence * 100)}%`}
                      </span>
                    )}
                    {/* In-session verification badge (report_finding gate): the model reproduced and classified the defect
                        before reporting — the gate only filters unverified candidates, never whole categories. */}
                    {f.verification && (
                      <span
                        className="px-1.5 py-0.5 rounded text-[11px]"
                        title={`${t('explorations:verificationExpected')}：${f.verification.expected} · ${t('explorations:verificationActual')}：${f.verification.actual}`}
                        style={{ background: 'var(--muted)', color: 'var(--foreground)' }}
                      >
                        {t('explorations:verification')}: {t(`explorations:verificationCategory.${f.verification.category}`)}
                        {` · ${t(`explorations:verificationConfidence.${f.verification.confidence}`)}`}
                      </span>
                    )}
                  </div>
                  <div className="text-[13px] whitespace-pre-wrap" style={{ color: 'var(--muted-foreground)' }}>
                    {f.description}
                  </div>

                  {/* Verification detail (report_finding gate): expected vs actual + evidence list from the in-session verification. */}
                  {f.verification && (
                    <div className="rounded-[var(--radius-sm)] border p-2.5 flex flex-col gap-1" style={{ borderColor: 'var(--border)' }}>
                      <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--foreground)' }}>
                        <span style={{ color: 'var(--muted-foreground)' }}>{t('explorations:verificationExpected')}：</span>
                        <span className="truncate">{f.verification.expected}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--foreground)' }}>
                        <span style={{ color: 'var(--muted-foreground)' }}>{t('explorations:verificationActual')}：</span>
                        <span className="truncate">{f.verification.actual}</span>
                      </div>
                      {f.verification.evidence.length > 0 && (
                        <ul className="text-[11px] list-disc pl-5 flex flex-col gap-0.5" style={{ color: 'var(--muted-foreground)' }}>
                          {f.verification.evidence.map((e, i) => (
                            <li key={i}>{e}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

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
                    <>
                      <button
                        type="button"
                        onClick={() => setZoom(img)}
                        className="self-start"
                        title={t('explorations:zoomImage')}
                        style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden', lineHeight: 0 }}
                      >
                        <img src={img} alt={f.title} style={{ maxHeight: 180, display: 'block' }} />
                      </button>
                      {/* Decision frame (A1): the screenshot is captured at "the moment the model judged" and persisted before the fact (not re-shot afterwards) — metadata pins the frame's state. */}
                      {f.evidenceFrame && (
                        <div className="text-[10px]" style={{ color: 'var(--muted-foreground)' }}>
                          {t('explorations:evidenceFrame')}
                          {f.evidenceFrame.viewport
                            ? ` · ${f.evidenceFrame.viewport.width}×${f.evidenceFrame.viewport.height}`
                            : ''}
                          {` · ${fullDateTime(f.evidenceFrame.capturedAt)}`}
                        </div>
                      )}
                    </>
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

      {/* Promote to case: pick group */}
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

      {/* Evidence screenshot zoom */}
      <Dialog open={!!zoom} onOpenChange={(open) => { if (!open) setZoom(null); }}>
        <DialogContent style={{ maxWidth: 900 }}>
          {zoom && <img src={zoom} alt={t('explorations:zoomImage')} style={{ width: '100%', display: 'block' }} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
