import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import Icon from '../components/Icon';
import LiveViewCard from '../components/LiveViewCard';
import StatusPill from '../components/ui/StatusPill';
import EmptyState from '../components/ui/EmptyState';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/Modal';
import Button from '../components/ui/Button';
import { useUIStore } from '../stores/ui';
import { fullDateTime } from '../lib/format';
import type { DbQueryRowResult, ObserveLogLineResult, HttpStepResult } from '@itest/shared';

/** 步骤级 LLM 用量（aiTask / 验证码 / vision 判定累加）；与 apps/api execute/aiUsage.ts 对齐。 */
interface AiUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  modelCallMs: number;
  retries: number;
  model?: string;
}

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
  /** Track 1 用例级视觉判定结果（最后一步/失败追加步携带） */
  visionAssert?: { passed: boolean; reason: string; screenshot?: string; expected?: string; aiUsage?: AiUsage };
  /** queryDb 步骤的结果（仅 queryDb 步携带） */
  db?: DbQueryRowResult;
  /** observeLog 步骤的结果（仅 observeLog 步携带） */
  log?: ObserveLogLineResult;
  /** httpRequest 步骤的结果（仅 httpRequest 步携带） */
  http?: HttpStepResult;
  /** aiTask 步骤本轮回放走了动作缓存（机械执行，零 LLM） */
  cached?: boolean;
  /** 缓存条目存在但重放分叉、AI 自愈通过（仅 passed 步携带） */
  healed?: boolean;
  /** 本步 LLM 用量；零调用步缺省 */
  aiUsage?: AiUsage;
}

/** tokens 千位缩写：1234 → 1.2k */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function aiUsageText(u: AiUsage): string {
  return `AI ${u.calls} 次调用 · ${fmtTokens(u.promptTokens + u.completionTokens)} tokens · ${(u.modelCallMs / 1000).toFixed(1)}s`;
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[12px] mb-2 last:mb-0">
      <span className="shrink-0" style={{ color: 'var(--muted-foreground)' }}>{label}</span>
      <span className="text-right truncate" style={{ color: 'var(--muted-foreground)' }}>{value}</span>
    </div>
  );
}

export default function ReportDetail() {
  const { id, projectId, versionId } = useParams<{ id: string; projectId: string; versionId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useUIStore((s) => s.showToast);
  const [zoomIndex, setZoomIndex] = useState<number | null>(null);
  const [showDelete, setShowDelete] = useState(false);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['report', id],
    queryFn: () => api.reports.get(id!),
    enabled: !!id,
    // 执行已异步化：running 期间 2s 轮询，报告从 running → passed/failed 时原地收敛
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 2000 : false),
  });

  const remove = useMutation({
    mutationFn: () => api.reports.remove(id!),
    onSuccess: () => {
      toast('已删除', 'success');
      qc.invalidateQueries({ queryKey: ['reports'] });
      qc.invalidateQueries({ queryKey: ['executions'] });
      qc.invalidateQueries({ queryKey: ['stats', projectId] });
      navigate(`/p/${projectId}/v/${versionId}/reports`);
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  if (isError) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--muted-foreground)', fontSize: 13 }}>
        加载失败：{error?.message ?? '未知错误'}
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--muted-foreground)' }}>
        <Icon name="loader" size={16} className="animate-spin" />
        <span style={{ marginLeft: 8 }}>加载中...</span>
      </div>
    );
  }

  // 执行已异步化：running 期间报告页直连 MJPEG 实时画面，跑完原地出报告。
  // 数据集运行整段共享一个流（key=case:<caseId>）：行 0 报告先行收尾但 run 仍在继续，
  // 行 0 页面保持画面直到整个 run 结束。结束后面面定格最后一帧 + 「回放」按钮（录制回放）。
  const isRunning = data.status === 'running';
  const keepLiveForDataset = data.datasetRowIndex === 0 && (data.datasetSnapshot?.totalRows ?? 1) > 1;

  const stepResults = (data.stepResults as StepResult[]) ?? [];
  const passed = stepResults.filter((s) => s.status === 'passed').length;
  const failed = stepResults.filter((s) => s.status === 'failed').length;
  // AI 调用汇总：步骤 aiUsage + visionAssert.aiUsage 全量求和
  const aiTotal = stepResults.reduce(
    (acc, s) => {
      for (const u of [s.aiUsage, s.visionAssert?.aiUsage]) {
        if (!u) continue;
        acc.calls += u.calls;
        acc.tokens += u.promptTokens + u.completionTokens;
        acc.ms += u.modelCallMs;
      }
      return acc;
    },
    { calls: 0, tokens: 0, ms: 0 },
  );
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
    ...(s.screenshot ? [{ s, url: s.screenshot, label: `Step #${s.order} 截图` }] : []),
    ...(s.visionAssert?.screenshot && s.visionAssert.screenshot !== s.screenshot
      ? [{ s, url: s.visionAssert.screenshot, label: `Step #${s.order} 视觉判定截图` }]
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
            {s.cached && (
              <Meta label="执行" value="缓存命中" muted />
            )}
            {s.healed && (
              <Meta label="执行" value="AI 自愈" title="缓存动作与页面分叉，AI 兜底重做后通过" />
            )}
            {s.aiUsage && (
              <Meta
                label="用量"
                value={aiUsageText(s.aiUsage) + (s.aiUsage.retries > 0 ? ` · 重试 ${s.aiUsage.retries}` : '')}
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
              <span className="shrink-0 font-medium">错误</span>
              <span className="min-w-0 break-words">{s.error}</span>
            </div>
          )}
          {s.error?.includes('var-missing:') && (
            <div
              className="flex gap-2 items-start text-[11px] px-2 py-1 rounded-[4px]"
              style={{ background: 'var(--warning-soft)', color: 'var(--warning)' }}
            >
              <span className="shrink-0 font-medium">变量</span>
              <span>未定义：在该步骤之前添加 extract 步骤抽取该变量，或检查变量名拼写（用例页保存步骤时会显示变量体检提示）。</span>
            </div>
          )}
          {s.warning && (
            <div
              className="flex gap-2 items-start text-[12px] px-2 py-1 rounded-[4px]"
              style={{ background: 'var(--warning-soft)', color: 'var(--warning)' }}
            >
              <span className="shrink-0 font-medium">警告</span>
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
              <span className="shrink-0 font-medium">{s.visionAssert.passed ? '视觉判定通过' : '视觉判定失败'}</span>
              <span className="min-w-0 break-words">{s.visionAssert.reason}</span>
            </div>
          )}
          {s.visionAssert?.expected && (
            <div className="text-[11px] font-mono px-2 py-1 min-w-0 break-words" style={{ color: 'var(--muted-foreground)' }}>
              判定预期（按本行数据物化）：{s.visionAssert.expected}
            </div>
          )}
          {s.visionAssert?.aiUsage && (
            <div className="text-[11px] font-mono px-2 py-1" style={{ color: 'var(--muted-foreground)' }}>
              视觉判定 {aiUsageText(s.visionAssert.aiUsage)}
            </div>
          )}
          {s.status !== 'passed' && (s.failureReason || s.humanMessage) && (
            <div className="flex flex-col gap-0.5 pl-2" style={{ borderLeft: '2px solid var(--destructive)' }}>
              {s.failureReason && (
                <div className="flex gap-2 items-start text-[11px]">
                  <span className="shrink-0 font-medium" style={{ color: 'var(--muted-foreground)' }}>原因</span>
                  <span className="font-mono min-w-0 break-words" style={{ color: 'var(--destructive)' }}>{s.failureReason}</span>
                </div>
              )}
              {s.humanMessage && (
                <div className="flex gap-2 items-start text-[11px]">
                  <span className="shrink-0 font-medium" style={{ color: 'var(--muted-foreground)' }}>说明</span>
                  <span className="min-w-0 break-words" style={{ color: 'var(--muted-foreground)' }}>{s.humanMessage}</span>
                </div>
              )}
            </div>
          )}
          {s.db && <DbResultCell db={s.db} />}
          {s.log && <LogResultCell log={s.log} />}
          {s.http && <HttpResultCell http={s.http} />}
        </div>
        {s.screenshot && (
          <button
            type="button"
            onClick={() => {
              const idx = shots.findIndex((x) => x.url === s.screenshot);
              setZoomIndex(idx >= 0 ? idx : 0);
            }}
            aria-label={`放大 step ${s.order} 截图`}
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
            aria-label={`放大 step ${s.order} 视觉判定截图`}
            className="shrink-0 rounded-[var(--radius-sm)] overflow-hidden press"
            style={{ border: '1px solid var(--border)', background: 'var(--popover)', padding: 0, cursor: 'zoom-in' }}
          >
            <img
              src={s.visionAssert.screenshot}
              alt={`step ${s.order} 视觉判定`}
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

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header bar */}
      <div className="flex items-center gap-3 px-6 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        {/* 计划运行成员报告：返回到所属计划运行详情；普通报告回报告列表 */}
        {data.planRunId && data.planId ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(`/p/${projectId}/v/${versionId}/plans/${data.planId}/runs/${data.planRunId}`)}
          >
            <Icon name="chevronLeft" size={12} />
            返回计划运行
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => navigate(`/p/${projectId}/v/${versionId}/reports`)}>
            <Icon name="chevronLeft" size={12} />
            返回报告列表
          </Button>
        )}
        <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
        <h1 className="text-[16px] font-semibold" style={{ color: 'var(--foreground)' }}>
          测试报告
        </h1>
        <StatusPill status={data.status}>{data.status.toUpperCase()}</StatusPill>
        {data.datasetSnapshot && data.datasetSnapshot.totalRows > 1 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(`/p/${projectId}/v/${versionId}/reports?tab=case&caseId=${data.caseId}`)}
            title={`该用例数据集共 ${data.datasetSnapshot.totalRows} 行，每行一份报告`}
          >
            全部 {data.datasetSnapshot.totalRows} 份
          </Button>
        )}
        {data.healed && (
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-full"
            style={{ background: 'var(--warning-soft)', color: 'var(--warning)' }}
            title="存在 aiTask 步骤缓存分叉后 AI 自愈通过——通过但不够稳定"
          >
            自愈通过
          </span>
        )}
        {data.platform === 'mobile' && (
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-full"
            style={{ background: 'var(--info-soft)', color: 'var(--info)' }}
          >
            <Icon name="tablet" size={11} />
            {data.mobileOs ?? 'mobile'}{data.deviceName ? ` · ${data.deviceName}` : ''}
          </span>
        )}
        <Button
          variant="ghost"
          onClick={() => setShowDelete(true)}
          style={{ color: 'var(--destructive)' }}
          aria-label="删除测试报告"
          title="删除测试报告"
        >
          <Icon name="trash" size={12} />
        </Button>
        <div className="flex-1" />
        <span className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
          {fullDateTime(data.createdAt)} · {data.durationMs ?? 0} ms
        </span>
      </div>

      {/* Body — 步骤时间线 + 右侧 metadata。截图与明细合并为单一步骤列表，每行同时展示时长 / 命中 locator / tab / 失败原因 / 缩略图。 */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="flex gap-5 p-6">
          <div className="flex-1 min-w-0 flex flex-col gap-3">
            {/* running|数据集末尾期间实时画面；结束后定格 + 回放按钮 */}
            <LiveViewCard
              liveUrl={api.cases.liveUrl(data.caseId)}
              replayUrl={(speed) => api.cases.replayUrl(data.caseId, speed)}
              replayMetaUrl={api.cases.replayMetaUrl(data.caseId)}
              running={isRunning || keepLiveForDataset}
            />
            {data.summary && (
              <div className="bg-card border rounded-[var(--radius-md)] p-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
                {data.summary}
              </div>
            )}
            <div className="bg-card border rounded-[var(--radius-md)] overflow-hidden">
              <div className="px-5 py-[10px] hairline-bottom" style={{ background: 'var(--muted)' }}>
                <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--muted-foreground)' }}>
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
            </div>
          </div>

          {/* Right rail — 统计 */}
          <div className="w-[280px] shrink-0 flex flex-col gap-3">
            <div className="bg-card border rounded-[var(--radius-md)] p-4">
              <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-3" style={{ color: 'var(--muted-foreground)' }}>
                汇总
              </div>
              <MetaRow label="总步骤" value={<span style={{ fontSize: 14, fontWeight: 600, color: 'var(--foreground)' }}>{stepResults.length}</span>} />
              <MetaRow label="通过" value={<span style={{ fontSize: 14, fontWeight: 600, color: 'var(--success)' }}>{passed}</span>} />
              <MetaRow label="失败" value={<span style={{ fontSize: 14, fontWeight: 600, color: 'var(--destructive)' }}>{failed}</span>} />
              {aiTotal.calls > 0 && (
                <MetaRow
                  label="AI 调用"
                  value={<span className="font-mono text-[11px]">{aiTotal.calls} 次 · {fmtTokens(aiTotal.tokens)} tokens · {(aiTotal.ms / 1000).toFixed(1)}s</span>}
                />
              )}
            </div>
            <div className="bg-card border rounded-[var(--radius-md)] p-4">
              <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-3" style={{ color: 'var(--muted-foreground)' }}>
                元数据
              </div>
              <MetaRow
                label="用例"
                value={data.caseTitle ?? <span style={{ color: 'var(--muted-foreground)' }}>已删除用例</span>}
              />
              <MetaRow label="用例 ID" value={<span className="font-mono text-[11px]">{data.caseId.slice(0, 8)}</span>} />
              <MetaRow label="报告 ID" value={<span className="font-mono text-[11px]">{data.id.slice(0, 8)}</span>} />
              {data.platform && (
                <MetaRow label="平台" value={data.platform} />
              )}
              {data.platform && (
                <MetaRow label="设备" value={`${data.mobileOs ?? data.platform}${data.deviceName ? ` · ${data.deviceName}` : ''}`} />
              )}
              {data.datasetRowIndex != null && data.datasetSnapshot && (
                <MetaRow label="数据行" value={`${data.datasetSnapshot.rowIndex + 1}/${data.datasetSnapshot.totalRows}`} />
              )}
            </div>
            {data.datasetSnapshot && (
              <div className="bg-card border rounded-[var(--radius-md)] p-4">
                <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-3" style={{ color: 'var(--muted-foreground)' }}>
                  当次数据行
                </div>
                {Object.entries(data.datasetSnapshot.values).map(([k, v]) => (
                  <MetaRow key={k} label={k} value={<span className="font-mono text-[11px]">{v}</span>} />
                ))}
              </div>
            )}
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
                  aria-label="上一步截图"
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
                  aria-label="下一步截图"
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

      {/* 删除确认 */}
      <Dialog open={showDelete} onOpenChange={setShowDelete}>
        <DialogContent style={{ maxWidth: 420 }}>
          <DialogHeader>
            <DialogTitle>删除测试报告</DialogTitle>
          </DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
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
        style={{ color: 'var(--muted-foreground)' }}
      >
        DB 查询：{db.rowCount} 行{db.truncated ? '（截断）' : ''}
        {db.assertion && (
          <span
            style={{
              color: db.assertion.matched ? 'var(--success)' : 'var(--destructive)',
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
          background: 'var(--muted)',
          color: 'var(--muted-foreground)',
          border: '1px solid var(--border)',
        }}
      >
        {JSON.stringify(db.rows.slice(0, 5), null, 2)}
      </pre>
    </details>
  );
}

function HttpResultCell({ http }: { http: HttpStepResult }) {
  const PRE_STYLE: React.CSSProperties = {
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
  };
  let path = '';
  try { path = new URL(http.request.url).pathname + new URL(http.request.url).search; } catch { path = http.request.url; }
  return (
    <details className="text-[11px]">
      <summary
        className="cursor-pointer"
        style={{ color: 'var(--muted-foreground)' }}
      >
        HTTP：{http.request.method} {path} → {http.response.status}（{http.response.durationMs}ms）
        {http.assertion && (
          <span
            style={{
              color: http.assertion.matched ? 'var(--success)' : 'var(--destructive)',
              marginLeft: 8,
            }}
          >
            {http.assertion.matched ? '✓ 命中' : '✕ 未命中'}
            {http.assertion.statusExpected !== undefined && ` 状态码 ${http.assertion.statusExpected}`}
            {http.assertion.expected !== undefined && `「${http.assertion.expected}」`}
          </span>
        )}
        {http.saved && (
          <span style={{ marginLeft: 8, color: 'var(--muted-foreground)' }}>
            提取 {`{{${http.saved.varName}}}`}
          </span>
        )}
      </summary>
      <div style={{ margin: '4px 0', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div>
          <div className="mb-0.5" style={{ color: 'var(--muted-foreground)' }}>请求头</div>
          <pre style={PRE_STYLE}>{JSON.stringify(http.request.headers, null, 2)}</pre>
        </div>
        {http.request.bodyPreview !== undefined && (
          <div>
            <div className="mb-0.5" style={{ color: 'var(--muted-foreground)' }}>请求体</div>
            <pre style={PRE_STYLE}>{http.request.bodyPreview}</pre>
          </div>
        )}
        <div>
          <div className="mb-0.5" style={{ color: 'var(--muted-foreground)' }}>
            响应 {http.response.status} {http.response.statusText}
          </div>
          <pre style={PRE_STYLE}>{http.response.bodyText || '（空）'}</pre>
        </div>
        {http.saved && (
          <div>
            <div className="mb-0.5" style={{ color: 'var(--muted-foreground)' }}>提取变量</div>
            <pre style={PRE_STYLE}>{`{{${http.saved.varName}}} = ${http.saved.value}`}</pre>
          </div>
        )}
      </div>
    </details>
  );
}

function LogResultCell({ log }: { log: ObserveLogLineResult }) {
  return (
    <details className="text-[11px]">
      <summary
        className="cursor-pointer"
        style={{ color: 'var(--muted-foreground)' }}
      >
        日志：匹配 {log.matchedLineCount} 行{log.truncated ? '（截断）' : ''}
        {log.assertion && (
          <span
            style={{
              color: log.assertion.matched ? 'var(--success)' : 'var(--destructive)',
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