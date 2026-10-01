import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import Icon from '../components/Icon';
import StatusPill from '../components/ui/StatusPill';
import EmptyState from '../components/ui/EmptyState';
import { fullDateTime } from '../lib/format';

interface StepResult {
  order: number;
  status: string;
  durationMs: number;
  error?: string;
  warning?: string;
  screenshot?: string;
  tabIndex?: number;
}

export default function ReportDetail() {
  const { id, projectId } = useParams<{ id: string; projectId: string }>();
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ['report', id],
    queryFn: () => api.reports.get(id!),
    enabled: !!id,
  });

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

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header bar */}
      <div className="flex items-center gap-3 px-6 py-3 shrink-0" style={{ borderBottom: '1px solid var(--color-glass-border)' }}>
        <button
          onClick={() => navigate(`/p/${projectId}/reports`)}
          className="flex items-center gap-1 text-[12px]"
          style={{ color: 'var(--color-foreground-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}
        >
          <Icon name="chevronLeft" size={12} />
          返回报告列表
        </button>
        <span style={{ width: 1, height: 16, background: 'var(--color-glass-border)' }} />
        <h1 className="text-[16px] font-semibold" style={{ color: 'var(--color-foreground)' }}>
          测试报告
        </h1>
        <StatusPill status={data.status}>{data.status.toUpperCase()}</StatusPill>
        <div className="flex-1" />
        <span className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>
          {fullDateTime(data.createdAt)} · {data.durationMs ?? 0} ms
        </span>
      </div>

      {/* Body — 步骤时间线 + 右侧 metadata */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="flex gap-5 p-6">
          <div className="flex-1 min-w-0 flex flex-col gap-3">
            {data.summary && (
              <div className="glass-card rounded-[12px] p-4 text-[13px]" style={{ color: 'var(--color-foreground-secondary)' }}>
                {data.summary}
              </div>
            )}
            <div className="glass-card rounded-[12px] overflow-hidden">
              <div className="px-5 py-[10px]" style={{ background: 'var(--color-background-subtle)', borderBottom: '1px solid var(--color-border)' }}>
                <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>
                  步骤时间线
                </span>
              </div>
              {stepResults.length === 0 ? (
                <EmptyState icon="listChecks" title="无步骤结果" />
              ) : (
                <div className="flex flex-col">
                  {(grouped.length === 1 && grouped[0]!.tabIndex === 0 && !hasTabs
                  ? grouped[0]!.steps.map((s, i) => (
                      <div
                        key={i}
                        className="flex gap-3 items-start px-5 py-3"
                        style={{ borderBottom: '1px solid var(--color-muted)' }}
                      >
                        <span
                          className="font-mono text-[12px] shrink-0 mt-0.5"
                          style={{ color: s.status === 'passed' ? 'var(--color-success)' : 'var(--color-destructive)' }}
                        >
                          {s.status === 'passed' ? '✓' : '✕'} #{s.order}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="text-[11px] font-mono" style={{ color: 'var(--color-foreground-muted)' }}>
                            {s.durationMs} ms
                          </div>
                          {s.error && (
                            <div className="text-[12px] mt-1" style={{ color: 'var(--color-destructive)' }}>
                              {s.error}
                            </div>
                          )}
                          {s.error?.includes('var-missing:') && (
                            <div className="text-[11px] mt-1" style={{ color: '#b45309' }}>
                              ↳ 变量未定义：请在该步骤之前添加 extract 步骤抽取该变量，或检查变量名拼写（用例页保存步骤时会显示变量体检提示）。
                            </div>
                          )}
                          {s.warning && (
                            <div className="text-[12px] mt-1" style={{ color: '#b45309' }}>
                              ⚠ {s.warning}
                            </div>
                          )}
                        </div>
                        {s.screenshot && (
                          <img
                            src={s.screenshot}
                            alt={`step ${s.order}`}
                            className="w-16 h-16 rounded-[6px] object-cover"
                            style={{ border: '1px solid var(--color-glass-border)' }}
                          />
                        )}
                      </div>
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
                          <div
                            key={i}
                            className="flex gap-3 items-start px-5 py-3"
                            style={{ borderBottom: '1px solid var(--color-muted)' }}
                          >
                            <span
                              className="font-mono text-[12px] shrink-0 mt-0.5"
                              style={{ color: s.status === 'passed' ? 'var(--color-success)' : 'var(--color-destructive)' }}
                            >
                              {s.status === 'passed' ? '✓' : '✕'} #{s.order}
                            </span>
                            <div className="flex-1 min-w-0">
                              <div className="text-[11px] font-mono" style={{ color: 'var(--color-foreground-muted)' }}>
                                {s.durationMs} ms
                              </div>
                              {s.error && (
                                <div className="text-[12px] mt-1" style={{ color: 'var(--color-destructive)' }}>
                                  {s.error}
                                </div>
                              )}
                              {s.error?.includes('var-missing:') && (
                                <div className="text-[11px] mt-1" style={{ color: '#b45309' }}>
                                  ↳ 变量未定义：请在该步骤之前添加 extract 步骤抽取该变量，或检查变量名拼写（用例页保存步骤时会显示变量体检提示）。
                                </div>
                              )}
                              {s.warning && (
                                <div className="text-[12px] mt-1" style={{ color: '#b45309' }}>
                                  ⚠ {s.warning}
                                </div>
                              )}
                            </div>
                            {s.screenshot && (
                              <img
                                src={s.screenshot}
                                alt={`step ${s.order}`}
                                className="w-16 h-16 rounded-[6px] object-cover"
                                style={{ border: '1px solid var(--color-glass-border)' }}
                              />
                            )}
                          </div>
                        ))}
                      </div>
                    )))}
                </div>
              )}
            </div>
          </div>

          {/* Right rail — 统计 */}
          <div className="w-[280px] shrink-0 flex flex-col gap-3">
            <div className="glass-card rounded-[12px] p-4">
              <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-3" style={{ color: 'var(--color-foreground-muted)' }}>
                汇总
              </div>
              <div className="flex items-center justify-between mb-2">
                <span style={{ fontSize: 12, color: 'var(--color-foreground-secondary)' }}>总步骤</span>
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-foreground)' }}>{stepResults.length}</span>
              </div>
              <div className="flex items-center justify-between mb-2">
                <span style={{ fontSize: 12, color: 'var(--color-foreground-secondary)' }}>通过</span>
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-success)' }}>{passed}</span>
              </div>
              <div className="flex items-center justify-between">
                <span style={{ fontSize: 12, color: 'var(--color-foreground-secondary)' }}>失败</span>
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-destructive)' }}>{failed}</span>
              </div>
            </div>
            <div className="glass-card rounded-[12px] p-4">
              <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-3" style={{ color: 'var(--color-foreground-muted)' }}>
                元数据
              </div>
              <div className="flex justify-between text-[12px] mb-2">
                <span style={{ color: 'var(--color-foreground-muted)' }}>用例 ID</span>
                <span className="font-mono text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>{data.caseId.slice(0, 8)}</span>
              </div>
              <div className="flex justify-between text-[12px]">
                <span style={{ color: 'var(--color-foreground-muted)' }}>报告 ID</span>
                <span className="font-mono text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>{data.id.slice(0, 8)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}