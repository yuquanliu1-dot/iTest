import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import Icon from '../components/Icon';
import Segmented from '../components/ui/Segmented';
import StatusPill from '../components/ui/StatusPill';
import EmptyState from '../components/ui/EmptyState';
import Pagination from '../components/ui/Pagination';
import { shortDateTime, fullDateTime } from '../lib/format';

type Tab = 'all' | 'case' | 'plan';
const DEFAULT_PAGE_SIZE = 20;

export default function Executions() {
  const navigate = useNavigate();
  const { projectId } = useParams<{ projectId: string }>();
  const [tab, setTab] = useState<Tab>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const { data, isLoading } = useQuery({
    queryKey: ['executions', projectId, tab],
    queryFn: () => api.executions.list({ projectId, kind: tab }),
    enabled: !!projectId,
  });

  const rows = useMemo(() => (data ?? []).slice((page - 1) * pageSize, page * pageSize), [data, page, pageSize]);
  const total = data?.length ?? 0;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-5 pt-4 pb-0">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight" style={{ color: 'var(--color-foreground)' }}>执行历史</h1>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--color-foreground-muted)' }}>用例执行结果与计划运行汇总</p>
        </div>
      </div>
      <div className="px-5 pt-3 fade-up">
        <Segmented<Tab>
          options={[
            { value: 'all', label: '所有', icon: 'list' },
            { value: 'case', label: '单用例', icon: 'beaker' },
            { value: 'plan', label: '计划运行', icon: 'flag' },
          ]}
          value={tab}
          onChange={(t) => { setTab(t); setPage(1); }}
        />
      </div>
      <div
        className="flex-1 min-h-0 mx-5 mb-5 mt-4 flex flex-col rounded-[12px] overflow-hidden"
        style={{ background: 'var(--color-background-elevated)', border: '1px solid var(--color-glass-border)', boxShadow: 'var(--shadow-card)' }}
      >
        {isLoading ? (
          <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)', fontSize: 13 }}>
            <Icon name="loader" size={16} className="animate-spin" />
            <span style={{ marginLeft: 8 }}>加载中...</span>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon="flag" title="还没有执行记录" description="在执行计划或用例详情页运行测试后会出现在这里。" />
        ) : (
          <>
            <div className="grid grid-cols-[80px_1fr_120px_120px] items-center px-5 py-[10px] shrink-0" style={{ background: 'var(--color-background-subtle)', borderBottom: '1px solid var(--color-border)' }}>
              <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>类型</span>
              <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>标识</span>
              <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>状态</span>
              <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>时间</span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto" data-stagger>
              {rows.map((r) => (
                <div
                  key={r.id}
                  data-stagger-item
                  onClick={() => navigate(r.kind === 'plan' ? `/p/${projectId}/plans/${(r as { planId: string }).planId}/runs/${r.id}` : `/p/${projectId}/reports/${r.id}`)}
                  className="grid grid-cols-[80px_1fr_120px_120px] items-center px-5 py-[12px] cursor-pointer list-row-clickable hairline-bottom"
                >
                  <span className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>{r.kind === 'plan' ? '计划' : '用例'}</span>
                  <span className="text-[12px] truncate" style={{ color: 'var(--color-foreground-secondary)' }}>
                    {r.kind === 'plan' ? (
                      <span className="font-mono">run {r.id.slice(0, 8)}</span>
                    ) : (
                      <>
                        <span className="mr-2">{(r as { caseTitle: string | null }).caseTitle ?? '已删除用例'}</span>
                        <span className="font-mono text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>case {(r as { caseId: string }).caseId.slice(0, 8)}</span>
                      </>
                    )}
                  </span>
                  <span><StatusPill status={r.status}>{r.status}</StatusPill></span>
                  <span className="text-[11px] font-mono" style={{ color: 'var(--color-foreground-muted)' }} title={fullDateTime(r.createdAt)}>
                    {shortDateTime(r.createdAt)}
                  </span>
                </div>
              ))}
            </div>
            <Pagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
            />
          </>
        )}
      </div>
    </div>
  );
}
