import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import Icon from '../components/Icon';
import StatusPill from '../components/ui/StatusPill';
import EmptyState from '../components/ui/EmptyState';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/Modal';
import Button from '../components/ui/Button';
import { useUIStore } from '../stores/ui';
import { fullDateTime } from '../lib/format';
import type { DbQueryRowResult, ObserveLogLineResult } from '@itest/shared';

interface StepResult {
  order: number;
  status: string;
  durationMs: number;
  error?: string;
  warning?: string;
  screenshot?: string;
  tabIndex?: number;
  failureReason?: string;
  humanMessage?: string;
  hitLocator?: { kind: string; value: string };
  /** queryDb 步骤的结果（仅 queryDb 步携带） */
  db?: DbQueryRowResult;
  /** observeLog 步骤的结果（仅 observeLog 步携带） */
  log?: ObserveLogLineResult;
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[12px] mb-2 last:mb-0">
      <span className="shrink-0" style={{ color: 'var(--color-foreground-muted)' }}>{label}</span>
      <span className="text-right truncate" style={{ color: 'var(--color-foreground-secondary)' }}>{value}</span>
    </div>
  );
}

export default function ReportDetail() {
  const { id, projectId } = useParams<{ id: string; projectId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useUIStore((s) => s.showToast);
  const [zoomIndex, setZoomIndex] = useState<number | null>(null);
  const [showDelete, setShowDelete] = useState(false);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['report', id],
    queryFn: () => api.reports.get(id!),
    enabled: !!id,
  });

  const remove = useMutation({
    mutationFn: () => api.reports.remove(id!),
    onSuccess: () => {
      toast('已删除', 'success');
      qc.invalidateQueries({ queryKey: ['reports'] });
      qc.invalidateQueries({ queryKey: ['executions'] });
      qc.invalidateQueries({ queryKey: ['stats', projectId] });
      navigate(`/p/${projectId}/reports`);
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  if (isError) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)', fontSize: 13 }}>
        加载失败：{error?.message ?? '未知错误'}
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)' }}>
        <Icon name="loader" size={16} className="animate-spin" />
        <span style={{ marginLeft: 8 }}>加载中...</span>
      </div>
    );
  }

  const stepResults = (data.stepResults as StepResult[]) ?? [];
  const passed = stepResults.filter((s) => s.status === 'passed').length;
  const failed = stepResults.filter((s) => s.status === 'failed').length;
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
  // 放大灯箱只看带截图的步骤，保持左右翻页在「有图步骤」之间
  const shotSteps = stepResults
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => !!s.screenshot);
  const zoomed = zoomIndex !== null ? shotSteps[zoomIndex] ?? null : null;
  const gotoZoom = (next: number) => {
    if (shotSteps.length === 0) return;
    const wrapped = (next + shotSteps.length) % shotSteps.length;
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
          style={{ color: passed ? 'var(--color-success)' : 'var(--color-destructive)' }}
        >
          {passed ? '✓' : '✕'} #{s.order}
        </span>
        <div className="flex-1 min-w-0 flex flex-col gap-1.5">
          {/* 元信息：耗时 / 定位策略 / 标签页 —— 标签在前、值在后，分项独立，可读 */}
          <div className="flex items-center gap-2 flex-wrap text-[11px]">
            <Meta label="耗时" value={`${s.durationMs} ms`} mono />
            {s.hitLocator && (
              <Meta
                label="定位"
                value={s.hitLocator.kind}
                mono
                title={`${s.hitLocator.kind}: ${s.hitLocator.value}`}
              />
            )}
            {s.tabIndex !== undefined && (
              <Meta label="标签页" value={`#${s.tabIndex}`} mono muted />
            )}
          </div>
          {/* 错误 / 警告 / 变量提示 —— 用色块+图标直接说明这是什么类型的提示 */}
          {s.error && (
            <div
              className="flex gap-2 items-start text-[12px] px-2 py-1 rounded-[4px]"
              style={{ background: 'var(--color-destructive-light-strong)', color: 'var(--color-destructive-text, var(--color-destructive))' }}
            >
              <span className="shrink-0 font-medium">错误</span>
              <span className="min-w-0 break-words">{s.error}</span>
            </div>
          )}
          {s.error?.includes('var-missing:') && (
            <div
              className="flex gap-2 items-start text-[11px] px-2 py-1 rounded-[4px]"
              style={{ background: 'var(--color-warning-light)', color: 'var(--color-warning-text)' }}
            >
              <span className="shrink-0 font-medium">变量</span>
              <span>未定义：在该步骤之前添加 extract 步骤抽取该变量，或检查变量名拼写（用例页保存步骤时会显示变量体检提示）。</span>
            </div>
          )}
          {s.warning && (
            <div
              className="flex gap-2 items-start text-[12px] px-2 py-1 rounded-[4px]"
              style={{ background: 'var(--color-warning-light)', color: 'var(--color-warning-text)' }}
            >
              <span className="shrink-0 font-medium">警告</span>
              <span className="min-w-0 break-words">{s.warning}</span>
            </div>
          )}
          {s.status !== 'passed' && (s.failureReason || s.humanMessage) && (
            <div className="flex flex-col gap-0.5 pl-2" style={{ borderLeft: '2px solid var(--color-destructive)' }}>
              {s.failureReason && (
                <div className="flex gap-2 items-start text-[11px]">
                  <span className="shrink-0 font-medium" style={{ color: 'var(--color-foreground-muted)' }}>原因</span>
                  <span className="font-mono min-w-0 break-words" style={{ color: 'var(--color-destructive)' }}>{s.failureReason}</span>
                </div>
              )}
              {s.humanMessage && (
                <div className="flex gap-2 items-start text-[11px]">
                  <span className="shrink-0 font-medium" style={{ color: 'var(--color-foreground-muted)' }}>说明</span>
                  <span className="min-w-0 break-words" style={{ color: 'var(--color-foreground-secondary)' }}>{s.humanMessage}</span>
                </div>
              )}
            </div>
          )}
          {s.db && <DbResultCell db={s.db} />}
          {s.log && <LogResultCell log={s.log} />}
        </div>
        {s.screenshot && (
          <button
            type="button"
            onClick={() => {
              const idx = shotSteps.findIndex((x) => x.i === stepResults.indexOf(s));
              setZoomIndex(idx >= 0 ? idx : 0);
            }}
            aria-label={`放大 step ${s.order} 截图`}
            className="shrink-0 rounded-[var(--radius-sm)] overflow-hidden press"
            style={{ border: '1px solid var(--color-glass-border)', background: 'transparent', padding: 0, cursor: 'zoom-in' }}
          >
            <img
              src={s.screenshot}
              alt={`step ${s.order}`}
              className="w-16 h-16 object-cover block"
            />
          </button>
        )}
      </div>
    );
  };

  // 单个元信息单元：标签 + 值，避免堆在一起时看不出来哪个是哪个
  const Meta = ({ label, value, mono, muted, title }: { label: string; value: string; mono?: boolean; muted?: boolean; title?: string }) => (
    <span
      title={title}
      className="inline-flex items-center gap-1"
      style={{ color: 'var(--color-foreground-muted)' }}
    >
      <span style={{ color: 'var(--color-foreground-muted)' }}>{label}</span>
      <span
        className={mono ? 'font-mono' : ''}
        style={{ color: muted ? 'var(--color-foreground-muted)' : 'var(--color-foreground-secondary)' }}
      >
        {value}
      </span>
    </span>
  );

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header bar */}
      <div className="flex items-center gap-3 px-6 py-3 shrink-0" style={{ borderBottom: '1px solid var(--color-glass-border)' }}>
        <Button variant="ghost" size="sm" onClick={() => navigate(`/p/${projectId}/reports`)}>
          <Icon name="chevronLeft" size={12} />
          返回报告列表
        </Button>
        <span style={{ width: 1, height: 16, background: 'var(--color-glass-border)' }} />
        <h1 className="text-[16px] font-semibold" style={{ color: 'var(--color-foreground)' }}>
          测试报告
        </h1>
        <StatusPill status={data.status}>{data.status.toUpperCase()}</StatusPill>
        <Button
          variant="ghost"
          onClick={() => setShowDelete(true)}
          style={{ color: 'var(--color-destructive)' }}
          aria-label="删除测试报告"
          title="删除测试报告"
        >
          <Icon name="trash" size={12} />
        </Button>
        <div className="flex-1" />
        <span className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>
          {fullDateTime(data.createdAt)} · {data.durationMs ?? 0} ms
        </span>
      </div>

      {/* Body — 步骤时间线 + 右侧 metadata。截图与明细合并为单一步骤列表，每行同时展示时长 / 命中 locator / tab / 失败原因 / 缩略图。 */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="flex gap-5 p-6">
          <div className="flex-1 min-w-0 flex flex-col gap-3">
            {data.summary && (
              <div className="glass-card rounded-[var(--radius-md)] p-4 text-[13px]" style={{ color: 'var(--color-foreground-secondary)' }}>
                {data.summary}
              </div>
            )}
            <div className="glass-card rounded-[var(--radius-md)] overflow-hidden">
              <div className="px-5 py-[10px] hairline-bottom" style={{ background: 'var(--color-background-subtle)' }}>
                <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>
                  步骤时间线
                </span>
              </div>
              {stepResults.length === 0 ? (
                <EmptyState icon="listChecks" title="无步骤结果" />
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
                          style={{ color: 'var(--color-foreground-muted)', background: 'var(--color-background-subtle)' }}
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
            </div>
          </div>

          {/* Right rail — 统计 */}
          <div className="w-[280px] shrink-0 flex flex-col gap-3">
            <div className="glass-card rounded-[var(--radius-md)] p-4">
              <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-3" style={{ color: 'var(--color-foreground-muted)' }}>
                汇总
              </div>
              <MetaRow label="总步骤" value={<span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-foreground)' }}>{stepResults.length}</span>} />
              <MetaRow label="通过" value={<span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-success)' }}>{passed}</span>} />
              <MetaRow label="失败" value={<span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-destructive)' }}>{failed}</span>} />
            </div>
            <div className="glass-card rounded-[var(--radius-md)] p-4">
              <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-3" style={{ color: 'var(--color-foreground-muted)' }}>
                元数据
              </div>
              <MetaRow
                label="用例"
                value={data.caseTitle ?? <span style={{ color: 'var(--color-foreground-muted)' }}>已删除用例</span>}
              />
              <MetaRow label="用例 ID" value={<span className="font-mono text-[11px]">{data.caseId.slice(0, 8)}</span>} />
              <MetaRow label="报告 ID" value={<span className="font-mono text-[11px]">{data.id.slice(0, 8)}</span>} />
            </div>
          </div>
        </div>
      </div>

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
                <span style={{ paddingLeft: 2 }}>Step #{zoomed.s.order}</span>
                <span
                  style={{
                    padding: '2px 10px',
                    borderRadius: 9999,
                    background: 'rgba(0, 0, 0, 0.55)',
                    textShadow: 'none',
                  }}
                >
                  {zoomIndex! + 1} / {shotSteps.length}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button
                  type="button"
                  aria-label="上一步截图"
                  onClick={(e) => { e.stopPropagation(); gotoZoom(zoomIndex! - 1); }}
                  disabled={shotSteps.length <= 1}
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
                    src={zoomed.s.screenshot}
                    alt={`step ${zoomed.s.order} 截图`}
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
                  aria-label="下一步截图"
                  onClick={(e) => { e.stopPropagation(); gotoZoom(zoomIndex! + 1); }}
                  disabled={shotSteps.length <= 1}
                  className="zoom-nav-btn"
                >
                  <Icon name="chevronRight" size={20} />
                </button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <Dialog open={showDelete} onOpenChange={setShowDelete}>
        <DialogContent style={{ maxWidth: 420 }}>
          <DialogHeader>
            <DialogTitle>删除测试报告</DialogTitle>
          </DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--color-foreground-secondary)' }}>
            确认删除该测试报告？相关截图将一并清理，且不可恢复。
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowDelete(false)}>取消</Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => { setShowDelete(false); remove.mutate(); }}
            >
              {remove.isPending ? '删除中...' : '确认删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DbResultCell({ db }: { db: DbQueryRowResult }) {
  return (
    <details className="text-[11px]">
      <summary
        className="cursor-pointer"
        style={{ color: 'var(--color-foreground-muted)' }}
      >
        DB 查询：{db.rowCount} 行{db.truncated ? '（截断）' : ''}
        {db.assertion && (
          <span
            style={{
              color: db.assertion.matched ? 'var(--color-success)' : 'var(--color-destructive)',
              marginLeft: 8,
            }}
          >
            {db.assertion.matched ? '✓ 命中' : '✕ 未命中'}「{db.assertion.expected}」
          </span>
        )}
      </summary>
      <pre
        style={{
          maxHeight: 240,
          overflow: 'auto',
          fontSize: 11,
          margin: '4px 0',
          padding: 8,
          borderRadius: 4,
          background: 'var(--color-background-subtle)',
          color: 'var(--color-foreground-secondary)',
          border: '1px solid var(--color-glass-border)',
        }}
      >
        {JSON.stringify(db.rows.slice(0, 5), null, 2)}
      </pre>
    </details>
  );
}

function LogResultCell({ log }: { log: ObserveLogLineResult }) {
  return (
    <details className="text-[11px]">
      <summary
        className="cursor-pointer"
        style={{ color: 'var(--color-foreground-muted)' }}
      >
        日志：匹配 {log.matchedLineCount} 行{log.truncated ? '（截断）' : ''}
        {log.assertion && (
          <span
            style={{
              color: log.assertion.matched ? 'var(--color-success)' : 'var(--color-destructive)',
              marginLeft: 8,
            }}
          >
            {log.assertion.matched ? '✓ 命中' : '✕ 未命中'}「{log.assertion.expected}」
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
          background: 'var(--color-background-subtle)',
          color: 'var(--color-foreground-secondary)',
          border: '1px solid var(--color-glass-border)',
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
        }}
      >
        {log.lines.slice(0, 20).map((l, i) => (
          <div
            key={i}
            style={{
              background: l.raw.includes('ERROR') ? 'var(--color-destructive-light)' : undefined,
              padding: '1px 4px',
              borderRadius: 2,
              fontFamily: 'monospace',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {l.ts ? <span style={{ color: 'var(--color-foreground-muted)', marginRight: 6 }}>{l.ts}</span> : null}
            {l.raw}
          </div>
        ))}
      </div>
    </details>
  );
}