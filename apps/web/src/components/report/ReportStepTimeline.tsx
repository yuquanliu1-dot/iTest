import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../Icon';
import EmptyState from '../ui/EmptyState';
import { Dialog, DialogContent } from '../ui/Modal';
import { clockTime, fullDateTime, stepKindLabel } from '../../lib/format';
import { getKind, stepSummary, fullStepDescription } from '../../lib/stepSummary';
import type { DbQueryRowResult, ObserveLogLineResult, HttpStepResult, SyslogStepResult, SqlStepResult } from '@itest/shared';

/** 步骤级 LLM 用量（aiTask / 验证码 / vision 判定累加）；与 apps/api execute/aiUsage.ts 对齐。 */
interface AiUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  modelCallMs: number;
  retries: number;
  model?: string;
  /** 命中缓存的 prompt token 数（不含在 promptTokens 内）；老报告无此字段。 */
  cacheReadTokens?: number;
  /** 为建立缓存新写入的 token 数；老报告无此字段。 */
  cacheCreationTokens?: number;
}

export interface StepResult {
  order: number;
  status: string;
  durationMs: number;
  /** 本步开始时刻（ISO）；老报告缺失，此时不展示「开始」标签 */
  startedAt?: string;
  /** 行级自然语言说明快照（执行时步骤的 instruction；历史报告/录制用例可能缺省） */
  instruction?: string;
  /** compiled DSL 快照；无 instruction 时报告页据此生成动作摘要（与用例页同一套 stepSummary） */
  compiled?: unknown[];
  error?: string;
  warning?: string;
  screenshot?: string;
  tabIndex?: number;
  failureReason?: string;
  humanMessage?: string;
  hitLocator?: { kind: string; value: string };
  /** Track 1 用例级视觉判定结果（最后一步/失败追加步携带） */
  visionAssert?: { passed: boolean; reason: string; screenshot?: string; expected?: string; aiUsage?: AiUsage };
  /** queryDb 步骤的结果（仅 queryDb 步携带） */
  db?: DbQueryRowResult;
  /** sql 步骤的结果（仅 sql 步携带） */
  sql?: SqlStepResult;
  /** observeLog 步骤的结果（仅 observeLog 步携带） */
  log?: ObserveLogLineResult;
  /** httpRequest 步骤的结果（仅 httpRequest 步携带） */
  http?: HttpStepResult;
  /** sendSyslog 步骤的结果（仅 sendSyslog 步携带） */
  syslog?: SyslogStepResult;
  /** aiTask 步骤本轮回放走了动作缓存（机械执行，零 LLM） */
  cached?: boolean;
  /** 缓存条目存在但重放分叉、AI 自愈通过（仅 passed 步携带） */
  healed?: boolean;
  /** 机械执行受阻，由 AI 按步骤指令临场执行通过（回放 AI 降级，仅 passed 步携带） */
  degraded?: boolean;
  /** 本步 LLM 用量；零调用步缺省 */
  aiUsage?: AiUsage;
}

/** tokens 千位缩写：1234 → 1.2k */
export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** 缓存命中率：命中 / (本次新计算 + 命中)。分母为 0 时返回 null（老报告无缓存字段）。 */
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
    // 无缓存数据时必须给空串：undefined 会让 i18next 把 {{cacheHitSuffix}} 占位符原样留在输出里
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
 * 报告步骤时间线（ReportDetail 与 PlanRunDetail 内嵌详情共用）。
 * 只渲染步骤行列表 + 截图灯箱；外层卡片边框与标题头由调用方包。
 * 灯箱打开时经 onZoomOpenChange 通知调用方（ReportDetail 的行切换方向键要让路，避免灯箱开着切行）。
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
  // 按 tabIndex 分组：未设置 tabIndex 的步骤归入 tab #0 组（向后兼容 phase1 报告）
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
  // 放大灯箱按「图片」而非「步骤」建索引：一步可能有「执行截图」+「视觉判定截图」两张，
  // 若按步骤索引，点第二张缩略图会定位到该步、再渲染出第一张（被盖住的那张永远放大不出来）。
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
          {/* 步骤说明：与用例详情页步骤列表同构——类型标签 + instruction，无 instruction 用动作摘要；历史报告缺快照则不渲染 */}
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
          {/* 元信息：耗时 / 定位策略 / 标签页 —— 标签在前、值在后，分项独立，可读 */}
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
          {/* 错误 / 警告 / 变量提示 —— 用色块+图标直接说明这是什么类型的提示 */}
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
          {s.db && <DbResultCell db={s.db} />}
          {s.sql && <SqlResultCell sql={s.sql} />}
          {s.log && <LogResultCell log={s.log} />}
          {s.http && <HttpResultCell http={s.http} />}
          {s.syslog && <SyslogResultCell syslog={s.syslog} />}
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
        // 执行中且首步尚未落库：说明是「还没开始出结果」，不是「没结果」——别误导成空报告。
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

      {/* Lightbox — 全屏放大截图（复用 Dialog 提供焦点陷阱 + Esc）。
          左侧/右侧浮层按钮 + 键盘 ← / → 在所有带截图的步骤之间翻页；底部显示当前位置。 */}
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
              {/* 顶部一行：步骤 ID（左）+ 翻页计数（右），独立于图片容器，避免被 DialogContent overflow 裁剪 */}
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

/** 结果块统一样式：等宽、可换行、可滚动（SQL / 响应体都可能很长）。 */
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

/** 「请求」块：实际执行的 SQL（占位符形态）+ 绑定参数值。
 *  老报告没有 sql/params 字段 → 不渲染（不显示空块）。 */
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

function DbResultCell({ db }: { db: DbQueryRowResult }) {
  const { t } = useTranslation();
  return (
    <details className="text-[11px]">
      <summary
        className="cursor-pointer"
        style={{ color: 'var(--muted-foreground)' }}
      >
        {t('reports:db.summary', { count: db.rowCount })}{db.truncated ? t('reports:truncated') : ''}
        {db.assertion && (
          <span
            style={{
              color: db.assertion.matched ? 'var(--success)' : 'var(--destructive)',
              marginLeft: 8,
            }}
          >
            {t(db.assertion.matched ? 'reports:assertion.hit' : 'reports:assertion.miss')}{t('reports:assertion.quote', { expected: db.assertion.expected })}
          </span>
        )}
      </summary>
      <SqlRequestBlock sql={db.sql} params={db.params} />
      <div className="mb-0.5" style={{ color: 'var(--muted-foreground)' }}>{t('reports:db.result')}</div>
      <pre style={RESULT_PRE_STYLE}>
        {JSON.stringify(db.rows.slice(0, 5), null, 2)}
      </pre>
    </details>
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
