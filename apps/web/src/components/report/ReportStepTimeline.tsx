import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../Icon';
import EmptyState from '../ui/EmptyState';
import { Dialog, DialogContent } from '../ui/Modal';
import { clockTime, fullDateTime, stepKindLabel } from '../../lib/format';
import { getKind, stepSummary, fullStepDescription } from '../../lib/stepSummary';
import type { ObserveLogLineResult, HttpStepResult, SyslogStepResult, SqlStepResult, ConsoleLogEntry } from '@itest/shared';

/** Step-level LLM usage (aiTask / captcha / vision judgment accumulated); aligned with apps/api execute/aiUsage.ts. */
interface AiUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  modelCallMs: number;
  retries: number;
  model?: string;
  /** Cached prompt token count (not included in promptTokens); absent on legacy reports. */
  cacheReadTokens?: number;
  /** Tokens newly written to establish the cache; absent on legacy reports. */
  cacheCreationTokens?: number;
}

export interface StepResult {
  order: number;
  status: string;
  durationMs: number;
  /** Step start time (ISO); missing on legacy reports, in which case the "started" label is not shown */
  startedAt?: string;
  /** Row-level natural-language description snapshot (the step's instruction at execution time; historical reports / recorded cases may lack it) */
  instruction?: string;
  /** compiled DSL snapshot; when there is no instruction the report page builds the action summary from it (same stepSummary as the case page) */
  compiled?: unknown[];
  error?: string;
  warning?: string;
  screenshot?: string;
  tabIndex?: number;
  failureReason?: string;
  humanMessage?: string;
  hitLocator?: { kind: string; value: string };
  /** Track 1 case-level vision assertion result (carried by the last step / the appended step after a failure) */
  visionAssert?: { passed: boolean; reason: string; screenshot?: string; expected?: string; aiUsage?: AiUsage };
  /** Result of the sql step (carried by sql steps only) */
  sql?: SqlStepResult;
  /** Result of the observeLog step (carried by observeLog steps only) */
  log?: ObserveLogLineResult;
  /** Result of the httpRequest step (carried by httpRequest steps only) */
  http?: HttpStepResult;
  /** Result of the sendSyslog step (carried by sendSyslog steps only) */
  syslog?: SyslogStepResult;
  /** Browser console errors / uncaught JS exceptions within this step's window (absent on legacy reports / steps without errors) */
  console?: ConsoleLogEntry[];
  /** The aiTask step's replay this round went through the action cache (mechanical execution, zero LLM) */
  cached?: boolean;
  /** A cache entry existed but the replay diverged, and AI self-heal passed (carried by passed steps only) */
  healed?: boolean;
  /** Mechanical execution was blocked and the AI executed live per the step instruction (replay AI fallback, carried by passed steps only) */
  degraded?: boolean;
  /** This step's LLM usage; absent on zero-call steps */
  aiUsage?: AiUsage;
}

/** Thousand-scale token abbreviation: 1234 → 1.2k */
export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Cache hit rate: hits / (newly computed + hits). Returns null when the denominator is 0 (legacy reports lack cache fields). */
export function cacheHitRate(u: AiUsage): number | null {
  const read = u.cacheReadTokens ?? 0;
  const total = read + u.promptTokens;
  if (total <= 0 || read <= 0) return null;
  return Math.round((read / total) * 100);
}

export function aiUsageText(t: ReturnType<typeof useTranslation>['t'], u: AiUsage): string {
  const rate = cacheHitRate(u);
  return t('reports:aiUsage', {
    count: u.calls,
    tokens: fmtTokens(u.promptTokens + u.completionTokens),
    seconds: (u.modelCallMs / 1000).toFixed(1),
    // Must pass an empty string when there is no cache data: undefined makes i18next leave the {{cacheHitSuffix}} placeholder verbatim in the output
    cacheHitSuffix: rate != null ? t('reports:aiCacheHit', { rate }) : '',
  });
}

function Meta({ label, value, mono, muted, title }: { label: string; value: string; mono?: boolean; muted?: boolean; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1"
      style={{ color: 'var(--muted-foreground)' }}
    >
      <span style={{ color: 'var(--muted-foreground)' }}>{label}</span>
      <span
        className={mono ? 'font-mono' : ''}
        style={{ color: muted ? 'var(--muted-foreground)' : 'var(--muted-foreground)' }}
      >
        {value}
      </span>
    </span>
  );
}

/**
 * Report step timeline (shared by ReportDetail and the PlanRunDetail embedded detail).
 * Renders only the step row list + screenshot lightbox; the outer card border and title header are the caller's job.
 * When the lightbox opens, the caller is notified via onZoomOpenChange (ReportDetail's row-switching arrow keys must yield, so rows don't switch while the lightbox is open).
 */
export default function ReportStepTimeline({ stepResults, isRunning, onZoomOpenChange }: {
  stepResults: StepResult[];
  isRunning: boolean;
  onZoomOpenChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [zoomIndex, setZoomIndex] = useState<number | null>(null);

  useEffect(() => {
    onZoomOpenChange?.(zoomIndex !== null);
  }, [zoomIndex, onZoomOpenChange]);

  const hasTabs = stepResults.some((s) => typeof s.tabIndex === 'number');
  // Group by tabIndex: steps without a tabIndex go into tab group #0 (backward compatible with phase1 reports)
  const grouped: Array<{ tabIndex: number; steps: StepResult[] }> = [];
  if (hasTabs) {
    const map = new Map<number, StepResult[]>();
    for (const s of stepResults) {
      const idx = s.tabIndex ?? 0;
      const arr = map.get(idx) ?? [];
      arr.push(s);
      map.set(idx, arr);
    }
    for (const [idx, arr] of [...map.entries()].sort((a, b) => a[0] - b[0])) {
      grouped.push({ tabIndex: idx, steps: arr });
    }
  } else {
    grouped.push({ tabIndex: 0, steps: stepResults });
  }
  // The lightbox is indexed by "image" rather than "step": one step may carry both an execution screenshot and a vision-assertion screenshot.
  // Indexed by step, clicking the second thumbnail would land on that step and re-render the first image (the covered one could never be zoomed).
  const shots = stepResults.flatMap((s) => [
    ...(s.screenshot ? [{ s, url: s.screenshot, label: t('reports:shots.stepShot', { order: s.order }) }] : []),
    ...(s.visionAssert?.screenshot && s.visionAssert.screenshot !== s.screenshot
      ? [{ s, url: s.visionAssert.screenshot, label: t('reports:shots.stepShotVision', { order: s.order }) }]
      : []),
  ]);
  const zoomed = zoomIndex !== null ? shots[zoomIndex] ?? null : null;
  const gotoZoom = (next: number) => {
    if (shots.length === 0) return;
    const wrapped = (next + shots.length) % shots.length;
    setZoomIndex(wrapped);
  };

  const renderStepRow = (s: StepResult, key: string | number) => {
    const passed = s.status === 'passed';
    return (
      <div
        key={key}
        className="flex gap-3 items-start px-5 py-3 hairline-bottom"
      >
        <span
          className="font-mono text-[12px] shrink-0 mt-0.5 w-[44px]"
          style={{ color: passed ? 'var(--success)' : 'var(--destructive)' }}
        >
          {passed ? '✓' : '✕'} #{s.order}
        </span>
        <div className="flex-1 min-w-0 flex flex-col gap-1.5">
          {/* Step description: isomorphic with the case detail page's step list — kind label + instruction; falls back to the action summary when there is no instruction; not rendered when a historical report lacks the snapshot */}
          {(s.instruction?.trim() || (Array.isArray(s.compiled) && s.compiled.length > 0)) && (
            <div className="flex items-baseline gap-1.5 min-w-0" title={fullStepDescription(s, t)}>
              <span className="shrink-0 font-semibold" style={{ color: 'var(--primary)', fontSize: 10 }}>
                {t(stepKindLabel(getKind(s)))}
              </span>
              <span className="min-w-0 truncate text-[12px]" style={{ color: 'var(--foreground)' }}>
                {s.instruction?.trim() || stepSummary(s, t)}
              </span>
            </div>
          )}
          {/* Meta info: duration / locator strategy / tab — label first, value after, separate items for readability */}
          <div className="flex items-center gap-2 flex-wrap text-[11px]">
            <Meta label={t('reports:meta.duration')} value={`${s.durationMs} ms`} mono />
            {s.startedAt && (
              <Meta label={t('reports:meta.startTime')} value={clockTime(s.startedAt)} mono title={fullDateTime(s.startedAt)} />
            )}
            {s.hitLocator && (
              <Meta
                label={t('reports:meta.locator')}
                value={s.hitLocator.kind}
                mono
                title={`${s.hitLocator.kind}: ${s.hitLocator.value}`}
              />
            )}
            {s.tabIndex !== undefined && (
              <Meta label={t('reports:meta.tabIndex')} value={`#${s.tabIndex}`} mono muted />
            )}
            {s.cached && (
              <Meta label={t('reports:meta.exec')} value={t('reports:stepExec.cached')} muted />
            )}
            {s.healed && (
              <Meta label={t('reports:meta.exec')} value={t('reports:stepExec.healed')} title={t('reports:stepExec.healedTitle')} />
            )}
            {s.degraded && (
              <Meta label={t('reports:meta.exec')} value={t('reports:stepExec.degraded')} title={t('reports:stepExec.degradedTitle')} />
            )}
            {s.aiUsage && (
              <Meta
                label={t('reports:meta.usage')}
                value={aiUsageText(t, s.aiUsage) + (s.aiUsage.retries > 0 ? t('reports:retrySuffix', { count: s.aiUsage.retries }) : '')}
                mono
                muted
              />
            )}
          </div>
          {/* Error / warning / variable hints — colored blocks + icons say outright what kind of notice this is */}
          {s.error && (
            <div
              className="flex gap-2 items-start text-[12px] px-2 py-1 rounded-[4px]"
              style={{ background: 'var(--destructive-soft-strong)', color: 'var(--destructive, var(--destructive))' }}
            >
              <span className="shrink-0 font-medium">{t('cases:status.error')}</span>
              <span className="min-w-0 break-words">{s.error}</span>
            </div>
          )}
          {s.error?.includes('var-missing:') && (
            <div
              className="flex gap-2 items-start text-[11px] px-2 py-1 rounded-[4px]"
              style={{ background: 'var(--warning-soft)', color: 'var(--warning)' }}
            >
              <span className="shrink-0 font-medium">{t('reports:stepNote.var')}</span>
              <span>{t('reports:stepNote.varUndefined')}</span>
            </div>
          )}
          {s.warning && (
            <div
              className="flex gap-2 items-start text-[12px] px-2 py-1 rounded-[4px]"
              style={s.degraded
                ? { background: 'var(--info-soft)', color: 'var(--info)' }
                : { background: 'var(--warning-soft)', color: 'var(--warning)' }}
            >
              <span className="shrink-0 font-medium">{s.degraded ? t('reports:stepNote.degradedExec') : t('reports:stepNote.warning')}</span>
              <span className="min-w-0 break-words">{s.warning}</span>
            </div>
          )}
          {s.visionAssert && (
            <div
              className="flex gap-2 items-start text-[12px] px-2 py-1 rounded-[4px]"
              style={{
                background: s.visionAssert.passed ? 'var(--success-soft)' : 'var(--destructive-soft-strong)',
                color: s.visionAssert.passed ? 'var(--success)' : 'var(--destructive)',
              }}
            >
              <span className="shrink-0 font-medium">{s.visionAssert.passed ? t('reports:stepNote.visionPassed') : t('reports:stepNote.visionFailed')}</span>
              <span className="min-w-0 break-words">{s.visionAssert.reason}</span>
            </div>
          )}
          {s.visionAssert?.expected && (
            <div className="text-[11px] font-mono px-2 py-1 min-w-0 break-words" style={{ color: 'var(--muted-foreground)' }}>
              {t('reports:stepNote.visionExpected', { expected: s.visionAssert.expected })}
            </div>
          )}
          {s.visionAssert?.aiUsage && (
            <div className="text-[11px] font-mono px-2 py-1" style={{ color: 'var(--muted-foreground)' }}>
              {t('reports:stepNote.visionUsage', { usage: aiUsageText(t, s.visionAssert.aiUsage) })}
            </div>
          )}
          {s.status !== 'passed' && (s.failureReason || s.humanMessage) && (
            <div className="flex flex-col gap-0.5 pl-2" style={{ borderLeft: '2px solid var(--destructive)' }}>
              {s.failureReason && (
                <div className="flex gap-2 items-start text-[11px]">
                  <span className="shrink-0 font-medium" style={{ color: 'var(--muted-foreground)' }}>{t('reports:stepNote.reason')}</span>
                  <span className="font-mono min-w-0 break-words" style={{ color: 'var(--destructive)' }}>{s.failureReason}</span>
                </div>
              )}
              {s.humanMessage && (
                <div className="flex gap-2 items-start text-[11px]">
                  <span className="shrink-0 font-medium" style={{ color: 'var(--muted-foreground)' }}>{t('reports:stepNote.note')}</span>
                  <span className="min-w-0 break-words" style={{ color: 'var(--muted-foreground)' }}>{s.humanMessage}</span>
                </div>
              )}
            </div>
          )}
          {s.sql && <SqlResultCell sql={s.sql} />}
          {s.log && <LogResultCell log={s.log} />}
          {s.http && <HttpResultCell http={s.http} />}
          {s.syslog && <SyslogResultCell syslog={s.syslog} />}
          {s.console && s.console.length > 0 && <ConsoleResultCell entries={s.console} />}
        </div>
        {s.screenshot && (
          <button
            type="button"
            onClick={() => {
              const idx = shots.findIndex((x) => x.url === s.screenshot);
              setZoomIndex(idx >= 0 ? idx : 0);
            }}
            aria-label={t('reports:shots.zoomStep', { order: s.order })}
            className="shrink-0 rounded-[var(--radius-sm)] overflow-hidden press"
            style={{ border: '1px solid var(--border)', background: 'var(--popover)', padding: 0, cursor: 'zoom-in' }}
          >
            <img
              src={s.screenshot}
              alt={`step ${s.order}`}
              className="w-16 h-16 object-cover block"
            />
          </button>
        )}
        {s.visionAssert?.screenshot && s.visionAssert.screenshot !== s.screenshot && (
          <button
            type="button"
            onClick={() => {
              const idx = shots.findIndex((x) => x.url === s.visionAssert!.screenshot);
              setZoomIndex(idx >= 0 ? idx : 0);
            }}
            aria-label={t('reports:shots.zoomStepVision', { order: s.order })}
            className="shrink-0 rounded-[var(--radius-sm)] overflow-hidden press"
            style={{ border: '1px solid var(--border)', background: 'var(--popover)', padding: 0, cursor: 'zoom-in' }}
          >
            <img
              src={s.visionAssert.screenshot}
              alt={t('reports:shots.altVision', { order: s.order })}
              className="w-16 h-16 object-cover block"
            />
          </button>
        )}
      </div>
    );
  };

  return (
    <>
      {stepResults.length === 0 ? (
        // Running and the first step hasn't landed yet: that's "no results yet", not "no results" — don't mislead into an empty report.
        isRunning ? (
          <div
            className="flex flex-col items-center justify-center gap-2 px-5 py-14"
            style={{ color: 'var(--muted-foreground)' }}
          >
            <Icon name="loader" size={16} className="animate-spin" />
            <span style={{ fontSize: 13 }}>{t('reports:detail.waitingFirstStep')}</span>
          </div>
        ) : (
          <EmptyState icon="listChecks" title={t('reports:detail.noStepsResult')} />
        )
      ) : (
        <div className="flex flex-col" data-stagger>
          {(grouped.length === 1 && grouped[0]!.tabIndex === 0 && !hasTabs
          ? grouped[0]!.steps.map((s, i) => (
              <div data-stagger-item key={i}>{renderStepRow(s, i)}</div>
            ))
          : grouped.map((group) => (
              <div key={group.tabIndex}>
                <div
                  className="px-5 py-[6px] text-[10px] font-mono"
                  style={{ color: 'var(--muted-foreground)', background: 'var(--muted)' }}
                >
                  tab #{group.tabIndex}
                </div>
                {group.steps.map((s, i) => (
                  <div data-stagger-item key={i}>{renderStepRow(s, `${group.tabIndex}-${i}`)}</div>
                ))}
              </div>
            )))}
        </div>
      )}

      {/* Lightbox — fullscreen screenshot zoom (reuses Dialog for the focus trap + Esc).
          Left/right floating buttons + keyboard ← / → page through every step that has a screenshot; the footer shows the current position. */}
      <Dialog open={zoomed !== null} onOpenChange={(o) => !o && setZoomIndex(null)}>
        <DialogContent
          style={{
            maxWidth: 'calc(100vw - 48px)',
            width: 'auto',
            background: 'transparent',
            border: 'none',
            boxShadow: 'none',
            padding: 0,
          }}
          onClick={() => setZoomIndex(null)}
        >
          {zoomed && (
            <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              {/* Top row: step id (left) + page counter (right), independent of the image container so DialogContent overflow doesn't clip it */}
              <div
                style={{
                  width: 'calc(100vw - 168px)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  fontSize: 12,
                  fontWeight: 500,
                  color: '#fff',
                  textShadow: '0 1px 2px rgba(0, 0, 0, 0.55)',
                  pointerEvents: 'none',
                }}
              >
                <span style={{ paddingLeft: 2 }}>{zoomed.label}</span>
                <span
                  style={{
                    padding: '2px 10px',
                    borderRadius: 9999,
                    background: 'rgba(0, 0, 0, 0.55)',
                    textShadow: 'none',
                  }}
                >
                  {zoomIndex! + 1} / {shots.length}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button
                  type="button"
                  aria-label={t('reports:shots.prev')}
                  onClick={(e) => { e.stopPropagation(); gotoZoom(zoomIndex! - 1); }}
                  disabled={shots.length <= 1}
                  className="zoom-nav-btn"
                >
                  <Icon name="chevronLeft" size={20} />
                </button>
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{ cursor: 'default' }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowLeft') { e.preventDefault(); gotoZoom(zoomIndex! - 1); }
                    else if (e.key === 'ArrowRight') { e.preventDefault(); gotoZoom(zoomIndex! + 1); }
                  }}
                  tabIndex={-1}
                >
                  <img
                    src={zoomed.url}
                    alt={zoomed.label}
                    style={{
                      maxWidth: 'calc(100vw - 168px)',
                      maxHeight: 'calc(100vh - 140px)',
                      objectFit: 'contain',
                      borderRadius: 6,
                      display: 'block',
                    }}
                  />
                </div>
                <button
                  type="button"
                  aria-label={t('reports:shots.next')}
                  onClick={(e) => { e.stopPropagation(); gotoZoom(zoomIndex! + 1); }}
                  disabled={shots.length <= 1}
                  className="zoom-nav-btn"
                >
                  <Icon name="chevronRight" size={20} />
                </button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Shared result-block style: monospace, wrappable, scrollable (SQL / response bodies can both be long). */
const RESULT_PRE_STYLE: React.CSSProperties = {
  maxHeight: 240,
  overflow: 'auto',
  fontSize: 11,
  margin: '4px 0',
  padding: 8,
  borderRadius: 4,
  background: 'var(--muted)',
  color: 'var(--muted-foreground)',
  border: '1px solid var(--border)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
};

/** "Request" block: the SQL actually executed (placeholder form) + bound parameter values.
 *  Legacy reports lack sql/params fields → not rendered (no empty block shown). */
function SqlRequestBlock({ sql, params }: { sql?: string; params?: unknown[] }) {
  const { t } = useTranslation();
  if (!sql && (!params || params.length === 0)) return null;
  return (
    <div style={{ margin: '4px 0', display: 'flex', flexDirection: 'column', gap: 4 }}>
      {sql && (
        <div>
          <div className="mb-0.5" style={{ color: 'var(--muted-foreground)' }}>{t('reports:sql.request')}</div>
          <pre style={RESULT_PRE_STYLE}>{sql}</pre>
        </div>
      )}
      {params && params.length > 0 && (
        <div>
          <div className="mb-0.5" style={{ color: 'var(--muted-foreground)' }}>{t('reports:sql.params')}</div>
          <pre style={RESULT_PRE_STYLE}>{JSON.stringify(params, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

function SqlResultCell({ sql }: { sql: SqlStepResult }) {
  const { t } = useTranslation();
  return (
    <details className="text-[11px]">
      <summary
        className="cursor-pointer"
        style={{ color: 'var(--muted-foreground)' }}
      >
        {t('reports:sql.summary', { count: sql.rowCount })}
        {sql.dbRef ? ` @${sql.dbRef}` : ''}
        {sql.truncated ? t('reports:truncated') : ''}
        {sql.assertion && (
          <span
            style={{
              color: sql.assertion.matched ? 'var(--success)' : 'var(--destructive)',
              marginLeft: 8,
            }}
          >
            {t(sql.assertion.matched ? 'reports:assertion.hit' : 'reports:assertion.miss')}{t('reports:assertion.quote', { expected: sql.assertion.expected })}
          </span>
        )}
      </summary>
      <SqlRequestBlock sql={sql.sql} params={sql.params} />
      <div className="mb-0.5" style={{ color: 'var(--muted-foreground)' }}>{t('reports:sql.result')}</div>
      <pre style={RESULT_PRE_STYLE}>
        {JSON.stringify(sql.rows.slice(0, 5), null, 2)}
      </pre>
    </details>
  );
}

/** Browser console errors / uncaught JS exceptions (this step's window). Legacy reports and error-free steps lack the field → not rendered. */
function ConsoleResultCell({ entries }: { entries: ConsoleLogEntry[] }) {
  const { t } = useTranslation();
  return (
    <details className="text-[11px]">
      <summary className="cursor-pointer" style={{ color: 'var(--destructive)' }}>
        {t('reports:console.summary', { count: entries.length })}
      </summary>
      <div style={{ margin: '4px 0', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {entries.map((c, i) => (
          <div key={i}>
            <div className="mb-0.5 font-mono" style={{ color: 'var(--muted-foreground)' }}>
              {c.type === 'pageerror' ? t('reports:console.pageerror') : t('reports:console.consoleError')}
            </div>
            <pre style={{ ...RESULT_PRE_STYLE, color: 'var(--destructive)' }}>{c.text}</pre>
          </div>
        ))}
      </div>
    </details>
  );
}

function HttpResultCell({ http }: { http: HttpStepResult }) {  const { t } = useTranslation();
  let path = '';
  try { path = new URL(http.request.url).pathname + new URL(http.request.url).search; } catch { path = http.request.url; }
  return (
    <details className="text-[11px]">
      <summary
        className="cursor-pointer"
        style={{ color: 'var(--muted-foreground)' }}
      >
        {http.response
          ? t('reports:http.summary', { method: http.request.method, path, status: http.response.status, ms: http.response.durationMs })
          : t('reports:http.summaryTransportFailure', { method: http.request.method, path })}
        {http.assertion && (
          <span
            style={{
              color: http.assertion.matched ? 'var(--success)' : 'var(--destructive)',
              marginLeft: 8,
            }}
          >
            {t(http.assertion.matched ? 'reports:assertion.hit' : 'reports:assertion.miss')}
            {http.assertion.statusExpected !== undefined && t('reports:assertion.statusCode', { code: http.assertion.statusExpected })}
            {http.assertion.expected !== undefined && t('reports:assertion.quote', { expected: http.assertion.expected })}
          </span>
        )}
        {http.saved && (
          <span style={{ marginLeft: 8, color: 'var(--muted-foreground)' }}>
            {t('reports:http.extract', { name: `{{${http.saved.varName}}}` })}
          </span>
        )}
      </summary>
      <div style={{ margin: '4px 0', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div>
          <div className="mb-0.5" style={{ color: 'var(--muted-foreground)' }}>{t('reports:http.requestLine')}</div>
          <pre style={RESULT_PRE_STYLE}>{`${http.request.method} ${http.request.url}`}</pre>
        </div>
        <div>
          <div className="mb-0.5" style={{ color: 'var(--muted-foreground)' }}>{t('reports:http.headers')}</div>
          <pre style={RESULT_PRE_STYLE}>{JSON.stringify(http.request.headers, null, 2)}</pre>
        </div>
        {http.request.bodyPreview !== undefined && (
          <div>
            <div className="mb-0.5" style={{ color: 'var(--muted-foreground)' }}>{t('reports:http.body')}</div>
            <pre style={RESULT_PRE_STYLE}>{http.request.bodyPreview}</pre>
          </div>
        )}
        {http.transportFailure ? (
          <div>
            <div className="mb-0.5" style={{ color: 'var(--muted-foreground)' }}>{t('reports:http.transportFailure')}</div>
            <pre style={RESULT_PRE_STYLE}>{http.transportFailure}</pre>
          </div>
        ) : (
          <>
            <div>
              <div className="mb-0.5" style={{ color: 'var(--muted-foreground)' }}>
                {t('reports:http.response', { status: http.response!.status, statusText: http.response!.statusText })}
              </div>
              <pre style={RESULT_PRE_STYLE}>{http.response!.bodyText || t('reports:http.emptyBody')}</pre>
            </div>
            {http.response!.headers && Object.keys(http.response!.headers).length > 0 && (
              <div>
                <div className="mb-0.5" style={{ color: 'var(--muted-foreground)' }}>{t('reports:http.responseHeaders')}</div>
                <pre style={RESULT_PRE_STYLE}>{JSON.stringify(http.response!.headers, null, 2)}</pre>
              </div>
            )}
          </>
        )}
        {http.saved && (
          <div>
            <div className="mb-0.5" style={{ color: 'var(--muted-foreground)' }}>{t('reports:http.extractVar')}</div>
            <pre style={RESULT_PRE_STYLE}>{`{{${http.saved.varName}}} = ${http.saved.value}`}</pre>
          </div>
        )}
      </div>
    </details>
  );
}

function SyslogResultCell({ syslog }: { syslog: SyslogStepResult }) {
  const { t } = useTranslation();
  return (
    <details className="text-[11px]">
      <summary
        className="cursor-pointer"
        style={{ color: 'var(--muted-foreground)' }}
      >
        {t('reports:syslog.summary', {
          protocol: syslog.protocol.toUpperCase(),
          host: syslog.host,
          port: syslog.port,
          ms: syslog.durationMs,
        })}
      </summary>
      <div style={{ margin: '4px 0', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div>
          <div className="mb-0.5" style={{ color: 'var(--muted-foreground)' }}>
            {t('reports:syslog.meta', { facility: syslog.facility, severity: syslog.severity, bytes: syslog.bytes })}
          </div>
          <pre style={RESULT_PRE_STYLE}>
            {syslog.packet}
          </pre>
        </div>
      </div>
    </details>
  );
}

function LogResultCell({ log }: { log: ObserveLogLineResult }) {
  const { t } = useTranslation();
  return (
    <details className="text-[11px]">
      <summary
        className="cursor-pointer"
        style={{ color: 'var(--muted-foreground)' }}
      >
        {t('reports:db.logSummary', { count: log.matchedLineCount })}{log.truncated ? t('reports:truncated') : ''}
        {log.assertion && (
          <span
            style={{
              color: log.assertion.matched ? 'var(--success)' : 'var(--destructive)',
              marginLeft: 8,
            }}
          >
            {t(log.assertion.matched ? 'reports:assertion.hit' : 'reports:assertion.miss')}{t('reports:assertion.quote', { expected: log.assertion.expected })}
          </span>
        )}
      </summary>
      <div
        style={{
          maxHeight: 240,
          overflow: 'auto',
          fontSize: 11,
          margin: '4px 0',
          padding: 8,
          borderRadius: 4,
          background: 'var(--muted)',
          color: 'var(--muted-foreground)',
          border: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
        }}
      >
        {log.lines.slice(0, 20).map((l, i) => (
          <div
            key={i}
            style={{
              background: l.raw.includes('ERROR') ? 'var(--destructive-soft)' : undefined,
              padding: '1px 4px',
              borderRadius: 2,
              fontFamily: 'monospace',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {l.ts ? <span style={{ color: 'var(--muted-foreground)', marginRight: 6 }}>{l.ts}</span> : null}
            {l.raw}
          </div>
        ))}
      </div>
    </details>
  );
}
