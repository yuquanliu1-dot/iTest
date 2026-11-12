import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { EXPLORATION_PERSONAS } from '@itest/shared';
import { localizeApiError } from '../i18n';
import { api, type ExplorationSession } from '../api/client';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import EmptyState from '../components/ui/EmptyState';
import StatusPill from '../components/ui/StatusPill';
import Toggle from '../components/ui/Toggle';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/Modal';
import Segmented from '../components/ui/Segmented';
import { fullDateTime } from '../lib/format';
import { creatorName } from '../lib/creatorName';
import {
  PageShell,
  PageShellActions,
  PageShellContent,
  PageShellDescription,
  PageShellHeader,
  PageShellTitle,
} from '../components/layout/PageShell';

/** Persona dropdown copy: the single source of truth lives in @itest/shared (labelZh/labelEn); pick a side by current language here. */
function personaLabel(key: string, lang: string): string {
  const p = EXPLORATION_PERSONAS.find((x) => x.key === key);
  if (!p) return key;
  return lang.startsWith('en') ? p.labelEn : p.labelZh;
}

export default function Explorations() {
  const { projectId, versionId } = useParams<{ projectId: string; versionId: string }>();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['explorations', projectId, versionId],
    queryFn: () => api.explorations.list({ versionId }),
    enabled: !!versionId,
  });
  const sessions = data?.items ?? [];

  const [showCreate, setShowCreate] = useState(false);
  const [charter, setCharter] = useState('');
  // Persona multi-select: 1 picked = single session; ≥2 picked = persona matrix (multiple parallel runs on the same charter, grouped, jumps to matrix view).
  // One entry, not two dialogs — no dual entry points for the same capability.
  // No session-title/matrix-name input: the api side has defaults (title = first 80 chars of the charter, label = N-persona matrix); two fewer fields, one fewer hurdle.
  const [personas, setPersonas] = useState<string[]>(['qa']);
  const [startUrl, setStartUrl] = useState('');
  const [allowDestructive, setAllowDestructive] = useState(false);
  const [allowFaultInjection, setAllowFaultInjection] = useState(false);
  // Turn budget: default 60 (same default backend-side, range 4~240); clearing = not sending = backend default.
  const [budgetTurns, setBudgetTurns] = useState<number | undefined>(60);
  // Test window, two states: default 1280×800 / custom width×height (aligned with the case detail window strategy; exploration runs headless so there is no "current window" state).
  const [windowMode, setWindowMode] = useState<'default' | 'custom'>('default');
  const [windowWidth, setWindowWidth] = useState<number | undefined>();
  const [windowHeight, setWindowHeight] = useState<number | undefined>();
  const windowCustomReady = windowMode !== 'custom' || ((windowWidth ?? 0) > 0 && (windowHeight ?? 0) > 0);
  // Advanced options collapsed by default: charter + persona are enough to start a run; start page/turns/window are tuning knobs,
  // and flattening them onto the first screen would crowd out the "what are we exploring this time" main line.
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Charter length shown live: below the minimum (10 chars) the hint turns amber — the button is disabled but the reason is spelled out.
  const charterLen = charter.trim().length;
  const charterTooShort = charterLen < 10;

  const togglePersona = (key: string) =>
    setPersonas((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  // Single-entry submit: 1 persona picked = single session (into the detail page); ≥2 = matrix group (into matrix view).
  // Window/budget apply to the matrix too (the backend matrix endpoint passes every field through to each session).
  const create = useMutation({
    mutationFn: async () => {
      const shared = {
        versionId: versionId!,
        charter: charter.trim(),
        allowDestructive,
        allowFaultInjection,
        budgetTurns,
        ...(startUrl.trim() ? { startUrl: startUrl.trim() } : {}),
        ...(windowMode === 'custom' && windowCustomReady ? { windowWidth, windowHeight } : {}),
      };
      if (personas.length === 1) {
        const s = await api.explorations.create({ ...shared, persona: personas[0] });
        return { single: true, id: s.id };
      }
      const m = await api.explorations.createMatrix({
        ...shared,
        personas,
      });
      return { single: false, id: m.matrixId };
    },
    onSuccess: (r) => {
      setCharter('');
      setStartUrl('');
      setPersonas(['qa']);
      setAllowDestructive(false);
      setAllowFaultInjection(false);
      setBudgetTurns(60);
      setWindowMode('default');
      setWindowWidth(undefined);
      setWindowHeight(undefined);
      setShowAdvanced(false);
      setShowCreate(false);
      toast(t(r.single ? 'explorations:createdToast' : 'explorations:matrixCreatedToast'), 'success');
      qc.invalidateQueries({ queryKey: ['explorations'] });
      navigate(
        r.single
          ? `/p/${projectId}/v/${versionId}/explorations/${r.id}`
          : `/p/${projectId}/v/${versionId}/explorations/matrix/${r.id}`,
      );
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const openDetail = (id: string) => navigate(`/p/${projectId}/v/${versionId}/explorations/${id}`);

  // ── Card inline actions: cancel / rerun / delete (same semantics and visibility conditions as the detail page) ──────────
  // Handle a session without entering the detail page: cancel = stop quickly; rerun = new session on the same charter; delete = irreversible, via confirm dialog.
  const listKey = ['explorations', projectId, versionId] as const;
  const cancelOne = useMutation({
    mutationFn: (id: string) => api.explorations.cancel(id),
    onSuccess: () => {
      toast(t('explorations:cancelRequested'), 'success');
      qc.invalidateQueries({ queryKey: listKey });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const rerunOne = useMutation({
    mutationFn: (s: ExplorationSession) =>
      api.explorations.create({
        versionId: versionId!,
        charter: s.charter,
        persona: s.persona,
        allowDestructive: s.allowDestructive,
        allowFaultInjection: s.allowFaultInjection,
        ...(s.startUrl ? { startUrl: s.startUrl } : {}),
        ...(s.windowWidth && s.windowHeight
          ? { windowWidth: s.windowWidth, windowHeight: s.windowHeight }
          : {}),
      }),
    onSuccess: () => {
      toast(t('explorations:rerunCreated'), 'success');
      qc.invalidateQueries({ queryKey: listKey });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  // Delete is irreversible (defect candidates and evidence screenshots go with it) → confirm on the card first, no one-click delete.
  const [deleteTarget, setDeleteTarget] = useState<ExplorationSession | null>(null);
  const removeOne = useMutation({
    mutationFn: (id: string) => api.explorations.remove(id),
    onSuccess: () => {
      toast(t('explorations:deletedToast'), 'success');
      setDeleteTarget(null);
      qc.invalidateQueries({ queryKey: listKey });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  return (
    <PageShell>
      <PageShellHeader>
        <PageShellTitle>{t('explorations:title')}</PageShellTitle>
        <PageShellActions>
          <Button onClick={() => setShowCreate(true)}>
            <Icon name="plus" size={14} />
            {t('explorations:newSession')}
          </Button>
        </PageShellActions>
        <PageShellDescription>{t('explorations:pageHint')}</PageShellDescription>
      </PageShellHeader>

      <PageShellContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-12" style={{ color: 'var(--muted-foreground)' }}>
            <Icon name="loader" size={16} className="animate-spin" />
            <span style={{ marginLeft: 8 }}>{t('cases:loading')}</span>
          </div>
        ) : isError ? (
          <div className="flex items-center justify-center py-12 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
            {t('common:loadFailed')}：{error?.message ?? t('common:unknownError')}
          </div>
        ) : sessions.length === 0 ? (
          <EmptyState
            icon="search"
            title={t('explorations:noSessions')}
            description={t('explorations:noSessionsHint')}
            action={
              <Button size="sm" onClick={() => setShowCreate(true)}>
                + {t('explorations:newSession')}
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-3">
            {sessions.map((s) => {
              const live = s.status === 'running' || s.status === 'pending';
              return (
                <div
                  key={s.id}
                  onClick={() => openDetail(s.id)}
                  className="bg-card border rounded-[var(--radius-md)] p-4 cursor-pointer hover-card"
                >
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[14px] font-semibold truncate" style={{ color: 'var(--foreground)' }}>
                          {s.title || t('explorations:emptySession')}
                        </span>
                        <StatusPill status={s.status} pulse={s.status === 'running'}>
                          {t(`cases:status.${s.status}`)}
                        </StatusPill>
                        {s.matrixId && (
                          <span
                            className="px-1.5 py-0.5 rounded text-[10px]"
                            style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}
                            title={s.matrixLabel ?? s.matrixId}
                          >
                            {s.matrixLabel || t('explorations:newMatrix')}
                            {s.matrixRole ? ` · ${personaLabel(s.matrixRole, i18n.language)}` : ''}
                          </span>
                        )}
                        {/* Defect candidate count: on the list page you can tell at a glance how many suspects this run produced —
                            when candidates exist they are prominently marked in warning color (number enlarged and bolded), 0 is muted to a grey chip,
                            so it never competes for attention with cards that genuinely have suspects. */}
                        <span
                          className="flex items-center gap-1 rounded-full px-2 py-0.5"
                          style={
                            (s.findingsCount ?? 0) > 0
                              ? {
                                  background: 'var(--warning-soft)',
                                  color: 'var(--warning)',
                                  boxShadow: 'inset 0 0 0 1px var(--warning-soft-border)',
                                }
                              : { background: 'var(--muted)', color: 'var(--muted-foreground)' }
                          }
                          title={t('explorations:findings')}
                        >
                          <Icon name="beaker" size={11} />
                          <span className="text-[11px]">{t('explorations:findings')}</span>
                          <span className="text-[13px] font-semibold tabular-nums leading-none">
                            {s.findingsCount ?? 0}
                          </span>
                        </span>
                      </div>
                      <div className="text-[12px] mt-1.5 line-clamp-2" style={{ color: 'var(--muted-foreground)' }}>
                        {s.charter}
                      </div>
                      <div className="text-[11px] mt-2 flex items-center gap-2 flex-wrap" style={{ color: 'var(--muted-foreground)' }}>
                        <span>{t('explorations:personaLabel')}：{personaLabel(s.persona, i18n.language)}</span>
                        <span>·</span>
                        <span>{fullDateTime(s.createdAt)}</span>
                        <span>·</span>
                        <span>{t('explorations:createdBy')}：{creatorName(s.createdBy)}</span>
                      </div>
                    </div>
                    {/* Inline actions: quick handling without entering the detail page. The button area stopPropagation so clicks do not trigger opening the detail. */}
                    <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                      {live ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => cancelOne.mutate(s.id)}
                          disabled={cancelOne.isPending || s.cancelRequested}
                          title={s.cancelRequested ? t('explorations:cancelRequested') : t('explorations:cancel')}
                          aria-label={t('explorations:cancel')}
                        >
                          <Icon name="pause" size={12} />
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => rerunOne.mutate(s)}
                          disabled={rerunOne.isPending}
                          title={t('explorations:rerun')}
                          aria-label={t('explorations:rerun')}
                        >
                          <Icon name="renew" size={12} />
                        </Button>
                      )}
                      {/* Running sessions cannot be deleted (the executor is still writing into them); cancel-requested ones are allowed through. */}
                      {(!live || s.cancelRequested) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteTarget(s)}
                          style={{ color: 'var(--destructive)' }}
                          title={t('explorations:deleteSession')}
                          aria-label={t('explorations:deleteSession')}
                        >
                          <Icon name="trash" size={12} />
                        </Button>
                      )}
                      <Icon name="chevronRight" size={14} className="shrink-0 mt-1" />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </PageShellContent>

      {/* New exploration session: single-column main line (charter → persona), tuning knobs tucked into "Advanced options", permissions as their own group.
          The only required field is the charter — length shown live, hint turns amber when below minimum (button disabled but the reason is spelled out). */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="sm:max-w-xl p-0 gap-0">
          <DialogHeader className="px-5 pt-4 pb-3 gap-1.5 pr-8">
            <DialogTitle className="text-[15px] font-semibold">{t('explorations:newSession')}</DialogTitle>
            <p className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
              {t('explorations:createIntro')}
            </p>
          </DialogHeader>

          <div className="flex flex-col gap-4 px-5 pb-4">
            {/* ① Exploration charter (required): the goal and boundaries of the whole session; the more specific it is, the deeper the AI dares to dig. */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <label htmlFor="exploration-charter" className="text-[12px] font-medium" style={{ color: 'var(--foreground)' }}>
                  {t('explorations:charter')}
                </label>
                <span className="px-1.5 py-px rounded text-[10px]" style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}>
                  {t('explorations:charterRequired')}
                </span>
                <span className="flex-1" />
                <span className="text-[11px] tabular-nums" style={{ color: 'var(--muted-foreground)' }}>
                  {t('explorations:charterCounter', { count: charterLen })}
                </span>
              </div>
              <textarea
                id="exploration-charter"
                className="input-base"
                rows={4}
                value={charter}
                placeholder={t('explorations:charterPlaceholder')}
                onChange={(e) => setCharter(e.target.value)}
              />
              <span className="text-[11px]" style={{ color: charterTooShort ? 'var(--warning)' : 'var(--muted-foreground)' }}>
                {charterTooShort ? t('explorations:charterTooShort') : t('explorations:charterHint')}
              </span>
            </div>

            {/* ② Exploration personas: pick 1 to run a single session, pick multiple for parallel runs on the same charter (cross-validating each other, making defects more credible). */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[12px] font-medium" style={{ color: 'var(--foreground)' }}>
                {t('explorations:matrixPersonas')}
              </label>
              <div className="flex flex-wrap gap-2">
                {EXPLORATION_PERSONAS.map((p) => {
                  const selected = personas.includes(p.key);
                  return (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => togglePersona(p.key)}
                      className="px-2.5 py-1 rounded-full text-[12px] border transition-colors"
                      style={{
                        borderColor: selected ? 'var(--primary)' : 'var(--border)',
                        background: selected ? 'var(--primary-soft, var(--muted))' : 'transparent',
                        color: selected ? 'var(--primary)' : 'var(--muted-foreground)',
                      }}
                    >
                      {personaLabel(p.key, i18n.language)}
                    </button>
                  );
                })}
              </div>
              <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                {t('explorations:matrixPersonasHint')}
              </span>
            </div>

            {/* ③ Exploration turns: the only knob for depth, on the main line and not collapsed. Fixed-width input + hint on the same line; a soft budget
                overrun winds down gracefully (all findings made so far are kept). */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[12px] font-medium" style={{ color: 'var(--foreground)' }}>
                {t('explorations:budgetTurns')}
              </label>
              <div className="flex items-center gap-3">
                <Input
                  className="w-24 shrink-0"
                  type="number"
                  min={4}
                  max={240}
                  value={budgetTurns ?? ''}
                  onChange={(e) => setBudgetTurns(e.target.value === '' ? undefined : Number(e.target.value))}
                />
                <span className="text-[11px] flex-1 min-w-0" style={{ color: 'var(--muted-foreground)' }}>
                  {t('explorations:budgetTurnsHint')}
                </span>
              </div>
            </div>

            {/* ④ Advanced options: start page/window are tuning knobs, collapsed by default — does not affect starting a run. */}
            <div className="flex flex-col gap-3">
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                aria-expanded={showAdvanced}
                className="flex items-center gap-1.5 text-left"
              >
                <Icon
                  name={showAdvanced ? 'chevronDown' : 'chevronRight'}
                  size={12}
                  className="shrink-0"
                  style={{ color: 'var(--muted-foreground)' }}
                />
                <span className="text-[12px] font-medium" style={{ color: 'var(--foreground)' }}>
                  {t('explorations:advancedOptions')}
                </span>
                <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                  {t('explorations:advancedOptionsHint')}
                </span>
              </button>
              {showAdvanced && (
                <div className="flex flex-col gap-3 pl-3.5" style={{ borderLeft: '1px solid var(--border)' }}>
                  <Input
                    label={t('explorations:startUrl')}
                    placeholder={t('explorations:startUrlPlaceholder')}
                    value={startUrl}
                    onChange={(e) => setStartUrl(e.target.value)}
                  />
                  {/* Test window: default 1280×800 / custom width×height (same window strategy as case detail, two-state version) */}
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[12px] font-medium" style={{ color: 'var(--foreground)' }}>
                      {t('explorations:windowSize')}
                    </span>
                    <div className="flex items-end gap-3 flex-wrap">
                      <Segmented
                        value={windowMode}
                        onChange={setWindowMode}
                        options={[
                          { label: t('explorations:windowDefault'), value: 'default' },
                          { label: t('cases:windowCustom'), value: 'custom' },
                        ]}
                      />
                      {windowMode === 'custom' && (
                        <>
                          <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                            {t('cases:width')}
                            <Input
                              size="sm"
                              type="number"
                              value={windowWidth ?? ''}
                              onChange={(e) => setWindowWidth(e.target.value === '' ? undefined : Number(e.target.value))}
                            />
                          </label>
                          <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                            {t('cases:height')}
                            <Input
                              size="sm"
                              type="number"
                              value={windowHeight ?? ''}
                              onChange={(e) => setWindowHeight(e.target.value === '' ? undefined : Number(e.target.value))}
                            />
                          </label>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* ⑤ Permissions (all off by default): the platform only honors these two authorization bits — charter wording does not count as authorization. */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium" style={{ color: 'var(--foreground)' }}>
                {t('explorations:permissionsTitle')}
              </span>
              <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                {t('explorations:permissionsHint')}
              </span>
              <div className="flex flex-col gap-2 mt-0.5">
                <div className="flex flex-col gap-0.5">
                  <Toggle
                    checked={allowDestructive}
                    onChange={setAllowDestructive}
                    label={t('explorations:allowDestructive')}
                  />
                  <span className="text-[11px] pl-[40px]" style={{ color: 'var(--muted-foreground)' }}>
                    {t('explorations:allowDestructiveHint')}
                  </span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <Toggle
                    checked={allowFaultInjection}
                    onChange={setAllowFaultInjection}
                    label={t('explorations:allowFaultInjection')}
                  />
                  <span className="text-[11px] pl-[40px]" style={{ color: 'var(--muted-foreground)' }}>
                    {t('explorations:allowFaultInjectionHint')}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <DialogFooter className="px-5 py-3" style={{ borderTop: '1px solid var(--border)' }}>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>{t('common:cancel')}</Button>
            <Button
              disabled={charterTooShort || personas.length === 0 || !windowCustomReady || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending
                ? t('common:loading')
                : personas.length >= 2
                  ? t('explorations:startExploringMatrix', { count: personas.length })
                  : t('explorations:startExploring')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete session confirm: irreversible (defect candidates and evidence screenshots go with it) */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('explorations:deleteSession')}</DialogTitle>
          </DialogHeader>
          <div className="px-5 py-2 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
            {t('explorations:deleteConfirm')}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>{t('common:cancel')}</Button>
            <Button
              variant="danger"
              disabled={removeOne.isPending}
              onClick={() => deleteTarget && removeOne.mutate(deleteTarget.id)}
            >
              {removeOne.isPending ? t('common:loading') : t('common:delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
