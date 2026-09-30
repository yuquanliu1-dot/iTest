import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import Icon from '../components/Icon';
import StatusPill from '../components/ui/StatusPill';
import EmptyState from '../components/ui/EmptyState';
import Pagination from '../components/ui/Pagination';
import { shortDateTime, fullDateTime } from '../lib/format';

const DEFAULT_PAGE_SIZE = 20;

const GRID_COLS = 'grid-cols-[minmax(120px,1.2fr)_minmax(90px,0.7fr)_minmax(90px,0.8fr)_minmax(120px,1fr)]';

export default function Reports() {
  const navigate = useNavigate();
  const { projectId } = useParams<{ projectId: string }>();
  const { data, isLoading } = useQuery({
    queryKey: ['reports', projectId],
    queryFn: () => api.reports.list(projectId),
    enabled: !!projectId,
  });

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const rows = useMemo(() => (data ?? []).slice((page - 1) * pageSize, page * pageSize), [data, page, pageSize]);
  const total = data?.length ?? 0;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Page header */}
      <div className="flex items-center justify-between px-5 pt-4 pb-0">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight" style={{ color: 'var(--color-foreground)' }}>
            报告
          </h1>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--color-foreground-muted)' }}>
            用例执行结果与步骤时间线
          </p>
        </div>
      </div>

      {/* Table card */}
      <div
        className="flex-1 min-h-0 mx-5 mb-5 flex flex-col rounded-[12px] overflow-hidden"
        style={{ background: 'var(--color-background-elevated)', border: '1px solid var(--color-glass-border)', boxShadow: 'var(--shadow-card)' }}
      >
        {isLoading ? (
          <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)', fontSize: 13 }}>
            <Icon name="loader" size={16} className="animate-spin" />
            <span style={{ marginLeft: 8 }}>加载中...</span>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon="flag" title="还没有报告" description="到用例详情页执行用例，结果会在这里汇总。" />
        ) : (
          <>
            <div className={`grid ${GRID_COLS} items-center px-5 py-[10px] shrink-0`} style={{ background: 'var(--color-background-subtle)', borderBottom: '1px solid var(--color-border)' }}>
              <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>用例 ID</span>
              <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>状态</span>
              <span className="text-[11px] font-medium uppercase tracking-[0.03em] text-right" style={{ color: 'var(--color-foreground-muted)' }}>耗时</span>
              <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>时间</span>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto">
              {rows.map((r) => (
                <div
                  key={r.id}
                  onClick={() => navigate(`/p/${projectId}/reports/${r.id}`)}
                  className={`grid ${GRID_COLS} items-center px-5 py-[12px] cursor-pointer transition-colors list-row-clickable`}
                  style={{ borderBottom: '1px solid var(--color-muted)' }}
                >
                  <span className="text-[11px] font-mono truncate" style={{ color: 'var(--color-foreground-muted)' }} title={r.caseId}>
                    {r.caseId.slice(0, 8)}
                  </span>
                  <span>
                    <StatusPill status={r.status}>{r.status}</StatusPill>
                  </span>
                  <span className="text-[12px] font-mono text-right" style={{ color: 'var(--color-foreground-secondary)' }}>
                    {r.durationMs != null ? `${r.durationMs} ms` : '—'}
                  </span>
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
