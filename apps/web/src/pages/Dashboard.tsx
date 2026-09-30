import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import Icon from '../components/Icon';
import StatusPill from '../components/ui/StatusPill';
import EmptyState from '../components/ui/EmptyState';
import { fullDateTime } from '../lib/format';

interface Stats {
  requirements: number;
  cases: number;
  reports: number;
  passes: number;
  failures: number;
  recentRuns: Array<{ id: string; caseId: string; targetType: string; status: string; startedAt: string }>;
}

const STATUS_LABELS: Record<string, string> = {
  requirement2cases: 'AI 生成用例',
  case2script: 'AI 生成步骤',
  execute: '执行用例',
};

/** 占位保留以备 Agent Run 类型落地后展示（dashboard 当前用 Report 拼接） */
void STATUS_LABELS;

export default function Dashboard() {
  const navigate = useNavigate();
  const stats = useQuery({
    queryKey: ['stats'],
    queryFn: async (): Promise<Stats> => {
      const [reqs, cases, reports] = await Promise.all([
        api.requirements.list(),
        api.cases.list(),
        api.reports.list(),
      ]);
      const passes = reports.filter((r) => r.status === 'passed').length;
      const failures = reports.filter((r) => r.status === 'failed').length;
      return {
        requirements: reqs.length,
        cases: cases.length,
        reports: reports.length,
        passes,
        failures,
        recentRuns: reports.slice(0, 6).map((r) => ({
          id: r.id,
          caseId: r.caseId,
          targetType: 'execute',
          status: r.status,
          startedAt: r.createdAt,
        })),
      };
    },
  });
  const { data: casesData } = useQuery({ queryKey: ['cases'], queryFn: () => api.cases.list() });
  const caseTitleMap = new Map((casesData ?? []).map((c) => [c.id, c.title]));

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Page header */}
      <div className="flex items-center justify-between px-5 pt-4 pb-0">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight" style={{ color: 'var(--color-foreground)' }}>
            总览
          </h1>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--color-foreground-muted)' }}>
            需求 → 用例 → 执行 全链路概览
          </p>
        </div>
      </div>

      {/* Stat cards — 4 列 grid，每张卡都是 iDO glass-panel 风格 */}
      <div className="grid grid-cols-4 gap-4 px-5 pt-4">
        {stats.isLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="glass-panel rounded-[12px] p-5 flex items-center justify-center"
              style={{ minHeight: 92, color: 'var(--color-foreground-muted)' }}
            >
              <Icon name="loader" size={16} className="animate-spin" />
            </div>
          ))
        ) : (
          [
            { label: '需求', value: stats.data?.requirements ?? 0, icon: 'listChecks', to: '/requirements', tone: 'var(--color-accent)' },
            { label: '用例', value: stats.data?.cases ?? 0, icon: 'beaker', to: '/cases', tone: 'var(--color-info)' },
            { label: '通过报告', value: stats.data?.passes ?? 0, icon: 'checkCircle', to: '/reports', tone: 'var(--color-success)' },
            { label: '失败报告', value: stats.data?.failures ?? 0, icon: 'exclamationCircle', to: '/reports', tone: 'var(--color-destructive)' },
          ].map((c) => (
            <div
              key={c.label}
              onClick={() => navigate(c.to)}
              className="glass-panel rounded-[12px] p-5 cursor-pointer hover-card"
              style={{ minHeight: 92 }}
            >
              <div className="flex items-center justify-between">
                <span style={{ fontSize: 12, color: 'var(--color-foreground-secondary)' }}>{c.label}</span>
                <Icon name={c.icon} size={14} style={{ color: c.tone }} />
              </div>
              <div style={{ fontSize: 28, fontWeight: 700, marginTop: 8, color: c.tone, lineHeight: 1 }}>
                {c.value}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Recent runs */}
      <div className="flex-1 min-h-0 mx-5 mb-5 mt-4 flex flex-col rounded-[12px] overflow-hidden"
        style={{ background: 'var(--color-background-elevated)', border: '1px solid var(--color-glass-border)', boxShadow: 'var(--shadow-card)' }}
      >
        <div className="px-5 py-[10px] shrink-0" style={{ background: 'var(--color-background-subtle)', borderBottom: '1px solid var(--color-border)' }}>
          <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>
            最近运行
          </span>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {stats.data && stats.data.recentRuns.length === 0 ? (
            <EmptyState icon="activity" title="还没有运行" description="到用例详情页执行用例，结果会在这里汇总。" />
          ) : (
            (stats.data?.recentRuns ?? []).map((r) => (
              <div
                key={r.id}
                onClick={() => navigate(`/reports/${r.id}`)}
                className="flex items-center gap-4 px-5 py-[12px] cursor-pointer list-row-clickable"
                style={{ borderBottom: '1px solid var(--color-muted)' }}
              >
                <Icon name="play" size={14} style={{ color: 'var(--color-foreground-muted)' }} />
                <span className="flex-1 truncate" style={{ fontSize: 13, color: 'var(--color-foreground)' }}>
                  {caseTitleMap.get(r.caseId) ?? r.caseId.slice(0, 8)}
                </span>
                <StatusPill status={r.status} pulse={r.status === 'running'}>{r.status}</StatusPill>
                <span className="text-[11px] font-mono shrink-0" style={{ color: 'var(--color-foreground-muted)' }} title={fullDateTime(r.startedAt)}>
                  {new Date(r.startedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}