import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import StatusPill from '../components/ui/StatusPill';
import EmptyState from '../components/ui/EmptyState';
import Pagination from '../components/ui/Pagination';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/Modal';
import Input from '../components/ui/Input';
import Button from '../components/ui/Button';
import { shortDateTime, fullDateTime } from '../lib/format';

const DEFAULT_PAGE_SIZE = 20;

const GRID_COLS = 'grid-cols-[minmax(240px,2fr)_minmax(90px,0.7fr)_minmax(120px,1fr)]';

export default function Requirements() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['requirements', projectId],
    queryFn: () => api.projects.requirements(projectId!),
    enabled: !!projectId,
  });

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  const create = useMutation({
    mutationFn: () => api.projects.createRequirement(projectId!, { title, content }),
    onSuccess: () => {
      setTitle('');
      setContent('');
      setShowCreate(false);
      toast('需求已创建', 'success');
      qc.invalidateQueries({ queryKey: ['requirements', projectId] });
      qc.invalidateQueries({ queryKey: ['project-stats', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const filtered = useMemo(() => {
    const list = data ?? [];
    if (!search.trim()) return list;
    return list.filter((r) => r.title.includes(search.trim()));
  }, [data, search]);

  const total = filtered.length;
  const rows = filtered.slice((page - 1) * pageSize, page * pageSize);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Page header */}
      <div className="flex items-center justify-between px-5 pt-4 pb-0">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight" style={{ color: 'var(--color-foreground)' }}>
            需求
          </h1>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--color-foreground-muted)' }}>
            AI 分析需求，生成测试用例
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-4 py-[7px] rounded-[8px] text-[13px] font-semibold bg-accent hover:bg-accent-hover active:scale-[0.97] transition-[background-color,transform] duration-150"
        >
          <Icon name="plus" size={14} />
          新建需求
        </button>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2.5 px-5 py-3">
        <div className="input-wrap flex-1">
          <Icon name="search" size={14} className="input-icon" />
          <input
            type="text"
            placeholder="搜索需求标题"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="input-base input-sm input-with-leading"
          />
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
          <EmptyState
            icon="listChecks"
            title={search ? '没有匹配的需求' : '还没有需求'}
            description={search ? undefined : '新建一条需求，然后用 AI 生成测试用例。'}
            action={!search ? <Button size="sm" onClick={() => setShowCreate(true)}>+ 新建需求</Button> : undefined}
          />
        ) : (
          <>
            <div className={`grid ${GRID_COLS} items-center px-5 py-[10px] shrink-0`} style={{ background: 'var(--color-background-subtle)', borderBottom: '1px solid var(--color-border)' }}>
              <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>标题</span>
              <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>状态</span>
              <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>创建时间</span>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto">
              {rows.map((r) => (
                <div
                  key={r.id}
                  onClick={() => navigate(`/p/${projectId}/requirements/${r.id}`)}
                  className={`grid ${GRID_COLS} items-center px-5 py-[12px] cursor-pointer transition-colors list-row-clickable`}
                  style={{ borderBottom: '1px solid var(--color-muted)' }}
                >
                  <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--color-foreground)' }}>
                    {r.title}
                  </span>
                  <span>
                    <StatusPill status={r.status}>{r.status}</StatusPill>
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

      {/* 新建需求弹窗 */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建需求</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <Input label="标题" placeholder="需求标题" value={title} onChange={(e) => setTitle(e.target.value)} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-foreground-secondary)' }}>需求描述</label>
              <textarea
                className="input-base"
                placeholder="详细描述需求内容，供 AI 生成用例"
                rows={5}
                value={content}
                onChange={(e) => setContent(e.target.value)}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <Button variant="plain" onClick={() => setShowCreate(false)}>取消</Button>
            <Button disabled={!title || !content || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? '创建中...' : '创建'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
