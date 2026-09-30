import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import Icon from '../components/Icon';
import StatusPill from '../components/ui/StatusPill';
import PriorityBadge from '../components/ui/PriorityBadge';
import EmptyState from '../components/ui/EmptyState';
import Pagination from '../components/ui/Pagination';
import Segmented from '../components/ui/Segmented';

const PRIORITIES = ['', 'P0', 'P1', 'P2', 'P3'] as const;
const DEFAULT_PAGE_SIZE = 20;

const GRID_COLS = 'grid-cols-[minmax(90px,70px)_minmax(240px,2fr)_minmax(90px,0.7fr)]';

export default function Cases() {
  const navigate = useNavigate();
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>('');
  const { data, isLoading } = useQuery({
    queryKey: ['cases', priority],
    queryFn: () => api.cases.list(priority || undefined),
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
            用例
          </h1>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--color-foreground-muted)' }}>
            AI 生成脚本，支持浏览器录制补充
          </p>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2.5 px-5 py-3">
        <Segmented
          options={PRIORITIES.map((p) => ({ value: p, label: p || '全部' }))}
          value={priority}
          onChange={(v) => { setPriority(v); setPage(1); }}
        />
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
          <EmptyState icon="beaker" title="还没有用例" description="到需求详情页，用 AI 从需求生成用例。" />
        ) : (
          <>
            <div className={`grid ${GRID_COLS} items-center px-5 py-[10px] shrink-0`} style={{ background: 'var(--color-background-subtle)', borderBottom: '1px solid var(--color-border)' }}>
              <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>优先级</span>
              <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>标题</span>
              <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>状态</span>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto">
              {rows.map((c) => (
                <div
                  key={c.id}
                  onClick={() => navigate(`/cases/${c.id}`)}
                  className={`grid ${GRID_COLS} items-center px-5 py-[12px] cursor-pointer transition-colors list-row-clickable`}
                  style={{ borderBottom: '1px solid var(--color-muted)' }}
                >
                  <span><PriorityBadge priority={c.priority} /></span>
                  <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--color-foreground)' }}>
                    {c.title}
                  </span>
                  <span>
                    <StatusPill status={c.status}>{c.status}</StatusPill>
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
