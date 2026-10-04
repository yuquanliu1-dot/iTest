import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import Icon from '../components/Icon';
import Card from '../components/ui/Card';
import Segmented from '../components/ui/Segmented';
import StatusPill from '../components/ui/StatusPill';
import EmptyState from '../components/ui/EmptyState';
import Pagination from '../components/ui/Pagination';
import Button from '../components/ui/Button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/Modal';
import { useUIStore } from '../stores/ui';
import { shortDateTime, fullDateTime } from '../lib/format';

type Tab = 'all' | 'case' | 'plan';
const DEFAULT_PAGE_SIZE = 20;

export default function Executions() {
  const navigate = useNavigate();
  const { projectId, versionId: vidParam } = useParams<{ projectId: string; versionId?: string }>();
  const versionId = vidParam ?? null;
  const qc = useQueryClient();
  const toast = useUIStore((s) => s.showToast);
  const [tab, setTab] = useState<Tab>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  // 批量删除只针对 kind === 'case'（即 report 行）；kind === 'plan' 行不参与勾选
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['executions', projectId, versionId, tab],
    queryFn: () => api.executions.list({ projectId, kind: tab }),
    enabled: !!projectId,
  });

  const rows = useMemo(() => (data ?? []).slice((page - 1) * pageSize, page * pageSize), [data, page, pageSize]);
  const total = data?.length ?? 0;

  // 当前页所有可勾选的报告 id（仅 case 类型）
  const selectableIds = useMemo(
    () => rows.filter((r) => r.kind === 'case').map((r) => r.id),
    [rows],
  );
  const allChecked = selectableIds.length > 0 && selectableIds.every((id) => checked.has(id));

  // 切 tab 时清空选中集，避免跨 tab 误选
  useEffect(() => { setChecked(new Set()); }, [tab]);

  const toggleAll = () => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (allChecked) selectableIds.forEach((id) => next.delete(id));
      else selectableIds.forEach((id) => next.add(id));
      return next;
    });
  };
  const toggleOne = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const batchDeleteReports = useMutation({
    mutationFn: (ids: string[]) => api.reports.removeBatch(ids),
    onSuccess: (r) => {
      toast(`已删除 ${r.count} 条报告`, 'success');
      setConfirmBatchDelete(false);
      setChecked(new Set());
      qc.invalidateQueries({ queryKey: ['executions'] });
      qc.invalidateQueries({ queryKey: ['reports'] });
      qc.invalidateQueries({ queryKey: ['stats', projectId] });
    },
    onError: (e: Error) => {
      toast(e.message, 'error');
      setConfirmBatchDelete(false);
    },
  });

  const checkedList = useMemo(() => Array.from(checked), [checked]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-5 pt-4 pb-0">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.03em] leading-[1.1]" style={{ color: 'var(--color-foreground)' }}>执行历史</h1>
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

      {/* 批量操作条 —— 仅在有勾选时显示；计划运行行不在勾选范围 */}
      {checked.size > 0 && (
        <div
          className="flex items-center gap-2 mx-5 mt-3 px-3 py-2 rounded-[var(--radius-sm)]"
          style={{ background: 'var(--color-accent-light)', border: '1px solid var(--color-glass-border)' }}
        >
          <span className="text-[12px]" style={{ color: 'var(--color-accent)' }}>已选 {checked.size} 条</span>
          <div className="flex-1" />
          <Button size="sm" variant="danger" onClick={() => setConfirmBatchDelete(true)}>
            <Icon name="trash" size={12} />
            批量删除
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setChecked(new Set())}>取消选择</Button>
        </div>
      )}

      <Card padding="none" className="flex-1 min-h-0 mx-5 mb-5 mt-4 flex flex-col overflow-hidden">
        {isLoading ? (
          <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)', fontSize: 13 }}>
            <Icon name="loader" size={16} className="animate-spin" />
            <span style={{ marginLeft: 8 }}>加载中...</span>
          </div>
        ) : isError ? (
          <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)', fontSize: 13 }}>
            加载失败：{error?.message ?? '未知错误'}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon="flag" title="还没有执行记录" description="在执行计划或用例详情页运行测试后会出现在这里。" />
        ) : (
          <>
            <div
              className={`grid items-center px-5 py-[10px] shrink-0 ${tab === 'plan' ? 'grid-cols-[80px_1fr_120px_120px_120px]' : 'grid-cols-[32px_80px_1fr_120px_120px_120px]'}`}
              style={{ background: 'var(--color-background-subtle)', borderBottom: '1px solid var(--color-border)' }}
            >
              {tab !== 'plan' ? (
                <input type="checkbox" checked={allChecked} onChange={toggleAll} aria-label="全选当前页" />
              ) : (
                <span />
              )}
              <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>类型</span>
              <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>标识</span>
              <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>版本</span>
              <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>状态</span>
              <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>时间</span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto" data-stagger>
              {rows.map((r) => (
                <div
                  key={r.id}
                  data-stagger-item
                  className={`grid items-center px-5 py-[12px] cursor-pointer list-row-clickable hairline-bottom ${tab === 'plan' ? 'grid-cols-[80px_1fr_120px_120px_120px]' : 'grid-cols-[32px_80px_1fr_120px_120px_120px]'}`}
                >
                  {tab !== 'plan' && r.kind === 'case' ? (
                    <input
                      type="checkbox"
                      checked={checked.has(r.id)}
                      onChange={() => toggleOne(r.id)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`选择 ${(r as { caseTitle?: string }).caseTitle ?? r.id}`}
                    />
                  ) : tab !== 'plan' ? (
                    <span />
                  ) : null}
                  <span
                    className="text-[12px]"
                    style={{ color: 'var(--color-foreground-muted)' }}
                    onClick={() => navigate(r.kind === 'plan' ? `/p/${projectId}/v/${versionId}/plans/${(r as { planId: string }).planId}/runs/${r.id}` : `/p/${projectId}/v/${versionId}/reports/${r.id}`)}
                  >
                    {r.kind === 'plan' ? '计划' : '用例'}
                  </span>
                  <span
                    className="text-[12px] truncate"
                    style={{ color: 'var(--color-foreground-secondary)' }}
                    onClick={() => navigate(r.kind === 'plan' ? `/p/${projectId}/v/${versionId}/plans/${(r as { planId: string }).planId}/runs/${r.id}` : `/p/${projectId}/v/${versionId}/reports/${r.id}`)}
                  >
                    {r.kind === 'plan' ? (
                      <span className="font-mono">run {r.id.slice(0, 8)}</span>
                    ) : (
                      <>
                        <span className="mr-2">{(r as { caseTitle: string | null }).caseTitle ?? '已删除用例'}</span>
                        <span className="font-mono text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>case {(r as { caseId: string }).caseId.slice(0, 8)}</span>
                      </>
                    )}
                  </span>
                  <span
                    className="text-[11px]"
                    style={{ color: 'var(--color-foreground-muted)' }}
                    title={(r as { versionName?: string | null }).versionName ?? undefined}
                  >
                    {(r as { versionName?: string | null }).versionName ?? '—'}
                  </span>
                  <span onClick={() => navigate(r.kind === 'plan' ? `/p/${projectId}/v/${versionId}/plans/${(r as { planId: string }).planId}/runs/${r.id}` : `/p/${projectId}/v/${versionId}/reports/${r.id}`)}><StatusPill status={r.status}>{r.status}</StatusPill></span>
                  <span
                    className="text-[11px] font-mono"
                    style={{ color: 'var(--color-foreground-muted)' }}
                    title={fullDateTime(r.createdAt)}
                    onClick={() => navigate(r.kind === 'plan' ? `/p/${projectId}/v/${versionId}/plans/${(r as { planId: string }).planId}/runs/${r.id}` : `/p/${projectId}/v/${versionId}/reports/${r.id}`)}
                  >
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
      </Card>

      {/* 批量删除确认 */}
      <Dialog open={confirmBatchDelete} onOpenChange={(open) => { if (!open) setConfirmBatchDelete(false); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>批量删除报告</DialogTitle></DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--color-foreground-secondary)' }}>
            确定删除已选的 <span style={{ color: 'var(--color-destructive)', fontWeight: 600 }}>{checked.size}</span> 条测试报告？相关截图将一并清理，且不可恢复。
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmBatchDelete(false)}>取消</Button>
            <Button
              variant="danger"
              disabled={batchDeleteReports.isPending || checked.size === 0}
              onClick={() => batchDeleteReports.mutate(checkedList)}
            >
              {batchDeleteReports.isPending ? '删除中...' : `删除 ${checked.size} 条`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
