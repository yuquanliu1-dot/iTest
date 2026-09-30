import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useProjectStore } from '../stores/project';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import StatusPill from '../components/ui/StatusPill';
import PriorityBadge from '../components/ui/PriorityBadge';
import EmptyState from '../components/ui/EmptyState';
import Pagination from '../components/ui/Pagination';
import Segmented from '../components/ui/Segmented';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/Modal';
import Input from '../components/ui/Input';
import Button from '../components/ui/Button';
import { shortDateTime } from '../lib/format';

const PRIORITIES = ['', 'P0', 'P1', 'P2', 'P3'] as const;
const DEFAULT_PAGE_SIZE = 20;
const GRID_COLS = 'grid-cols-[minmax(28px,32px)_minmax(90px,70px)_minmax(200px,2fr)_minmax(120px,1fr)_minmax(90px,0.7fr)_minmax(100px,0.9fr)]';

type GroupForm = { open: boolean; mode: 'create' | 'edit' | 'url'; id: string | null; name: string; defaultUrl: string };
const EMPTY_GROUP_FORM: GroupForm = { open: false, mode: 'create', id: null, name: '', defaultUrl: '' };

export default function GroupsPage() {
  const { projectId, groupId } = useParams<{ projectId: string; groupId: string }>();
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const current = useProjectStore((s) => s.current);

  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [groupForm, setGroupForm] = useState<GroupForm>(EMPTY_GROUP_FORM);
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState<{ id: string; name: string } | null>(null);
  const [copyModal, setCopyModal] = useState<{ caseIds: string[] } | null>(null);
  const [planModal, setPlanModal] = useState<{ caseIds: string[] } | null>(null);
  const [copyTarget, setCopyTarget] = useState('');
  const [planTarget, setPlanTarget] = useState('');
  const [confirmDeleteCase, setConfirmDeleteCase] = useState<{ id: string; title: string } | null>(null);

  const { data: groups, isLoading: groupsLoading } = useQuery({
    queryKey: ['groups', projectId],
    queryFn: () => api.projects.groups(projectId!),
    enabled: !!projectId,
  });

  const effectiveGroupId = groupId ?? '';
  const { data: cases, isLoading: casesLoading } = useQuery({
    queryKey: ['cases', projectId, effectiveGroupId, priority],
    queryFn: () =>
      api.cases.list(effectiveGroupId ? { groupId: effectiveGroupId, priority: priority || undefined } : { projectId: projectId!, priority: priority || undefined }),
    enabled: !!projectId,
  });

  const { data: plans } = useQuery({
    queryKey: ['plans', projectId],
    queryFn: () => api.projects.plans(projectId!),
    enabled: !!projectId,
  });

  const groupName = useMemo(
    () => new Map((groups ?? []).map((g) => [g.id, g.name])),
    [groups],
  );

  // 切换分组时清空勾选
  useEffect(() => {
    setChecked(new Set());
    setPage(1);
  }, [effectiveGroupId]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['cases', projectId] });
    qc.invalidateQueries({ queryKey: ['groups', projectId] });
    qc.invalidateQueries({ queryKey: ['projects'] });
  };

  const saveGroup = useMutation({
    mutationFn: async () => {
      const body = { name: groupForm.name, defaultUrl: groupForm.defaultUrl || undefined };
      if (groupForm.mode === 'create') return api.projects.createGroup(projectId!, body);
      return api.groups.patch(groupForm.id!, body);
    },
    onSuccess: () => {
      toast('分组已保存', 'success');
      setGroupForm(EMPTY_GROUP_FORM);
      qc.invalidateQueries({ queryKey: ['groups', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const deleteGroup = useMutation({
    mutationFn: (id: string) => api.groups.remove(id),
    onSuccess: () => {
      toast('分组已删除', 'success');
      setConfirmDeleteGroup(null);
      if (effectiveGroupId) navigate(`/p/${projectId}/groups`);
      qc.invalidateQueries({ queryKey: ['groups', projectId] });
    },
    onError: (e: Error) => {
      toast(e.message.includes('409') || e.message.includes('cases') ? '分组内仍有用例，无法删除' : e.message, 'error');
      setConfirmDeleteGroup(null);
    },
  });

  const copyCases = useMutation({
    mutationFn: async ({ caseIds, targetGroupId }: { caseIds: string[]; targetGroupId: string }) => {
      if (caseIds.length === 1) return api.cases.copy(caseIds[0]!, targetGroupId);
      return api.cases.copyBatch(caseIds, targetGroupId);
    },
    onSuccess: () => {
      toast('复制完成', 'success');
      setCopyModal(null);
      setCopyTarget('');
      invalidate();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const addToPlan = useMutation({
    mutationFn: async ({ caseIds, planId }: { caseIds: string[]; planId: string }) => {
      // PUT 是覆盖语义：取现有 + 追加去重
      const detail = await api.plans.get(planId);
      const merged = [...detail.cases.map((c) => c.id), ...caseIds].filter((v, i, arr) => arr.indexOf(v) === i);
      return api.plans.setCases(planId, merged);
    },
    onSuccess: () => {
      toast('已加入执行计划', 'success');
      setPlanModal(null);
      setPlanTarget('');
      qc.invalidateQueries({ queryKey: ['plans', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const deleteCase = useMutation({
    mutationFn: (id: string) => api.cases.remove(id),
    onSuccess: () => {
      toast('用例已删除', 'success');
      setConfirmDeleteCase(null);
      invalidate();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const rows = useMemo(() => (cases ?? []).slice((page - 1) * pageSize, page * pageSize), [cases, page, pageSize]);
  const total = cases?.length ?? 0;
  const allChecked = rows.length > 0 && rows.every((c) => checked.has(c.id));

  const toggleAll = () => {
    const next = new Set(checked);
    if (allChecked) rows.forEach((c) => next.delete(c.id));
    else rows.forEach((c) => next.add(c.id));
    setChecked(next);
  };

  const toggleOne = (id: string) => {
    const next = new Set(checked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChecked(next);
  };

  const checkedList = [...checked];

  return (
    <div className="flex flex-1 min-h-0">
      {/* 左侧分组树 */}
      <div
        className="shrink-0 flex flex-col overflow-y-auto"
        style={{ width: 216, borderRight: '1px solid var(--color-glass-border)', padding: '10px 8px' }}
      >
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>
            分组
          </span>
          <button
            title="新建分组"
            onClick={() => setGroupForm({ open: true, mode: 'create', id: null, name: '', defaultUrl: '' })}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-foreground-muted)', padding: 2 }}
          >
            <Icon name="plus" size={13} />
          </button>
        </div>

        <button
          onClick={() => navigate(`/p/${projectId}/groups`)}
          className="text-left px-2 py-1.5 rounded-[6px] text-[13px]"
          style={{
            background: !effectiveGroupId ? 'var(--color-accent-light)' : 'transparent',
            color: !effectiveGroupId ? 'var(--color-accent)' : 'var(--color-foreground-secondary)',
            border: 'none', cursor: 'pointer', fontWeight: !effectiveGroupId ? 500 : 400,
          }}
        >
          全部用例（{cases?.length ?? 0}）
        </button>

        {groupsLoading ? (
          <div className="flex justify-center py-4" style={{ color: 'var(--color-foreground-muted)' }}>
            <Icon name="loader" size={14} className="animate-spin" />
          </div>
        ) : (
          (groups ?? []).map((g) => (
            <div
              key={g.id}
              className="group flex items-center gap-1 px-2 py-1.5 rounded-[6px] cursor-pointer"
              style={{ background: effectiveGroupId === g.id ? 'var(--color-accent-light)' : 'transparent' }}
              onClick={() => navigate(`/p/${projectId}/groups/${g.id}`)}
            >
              <Icon name="gitBranch" size={12} style={{ color: 'var(--color-foreground-muted)', flexShrink: 0 }} />
              <span
                className="flex-1 truncate text-[13px]"
                style={{ color: effectiveGroupId === g.id ? 'var(--color-accent)' : 'var(--color-foreground-secondary)', fontWeight: effectiveGroupId === g.id ? 500 : 400 }}
                title={g.defaultUrl ?? undefined}
              >
                {g.name}
              </span>
              <span className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>{g.caseCount}</span>
              <span className="hidden group-hover:flex items-center" onClick={(e) => e.stopPropagation()}>
                <button
                  title="重命名"
                  onClick={() => setGroupForm({ open: true, mode: 'edit', id: g.id, name: g.name, defaultUrl: g.defaultUrl ?? '' })}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-foreground-muted)', padding: 2 }}
                >
                  <Icon name="pencil" size={11} />
                </button>
                <button
                  title="默认域名"
                  onClick={() => setGroupForm({ open: true, mode: 'url', id: g.id, name: g.name, defaultUrl: g.defaultUrl ?? '' })}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-foreground-muted)', padding: 2 }}
                >
                  <Icon name="externalLink" size={11} />
                </button>
                <button
                  title="删除分组"
                  onClick={() => setConfirmDeleteGroup({ id: g.id, name: g.name })}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-destructive)', padding: 2 }}
                >
                  <Icon name="trash" size={11} />
                </button>
              </span>
            </div>
          ))
        )}
      </div>

      {/* 右侧用例表 */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 pt-4 pb-0">
          <div>
            <h1 className="text-[22px] font-bold tracking-tight" style={{ color: 'var(--color-foreground)' }}>
              用例
            </h1>
            <p className="text-[13px] mt-0.5" style={{ color: 'var(--color-foreground-muted)' }}>
              {effectiveGroupId ? (groupName.get(effectiveGroupId) ?? '分组') : '项目全部用例'} · {current?.name}
            </p>
          </div>
          <Segmented
            options={PRIORITIES.map((p) => ({ value: p, label: p || '全部' }))}
            value={priority}
            onChange={(v) => { setPriority(v); setPage(1); }}
          />
        </div>

        {/* 批量操作条 */}
        {checked.size > 0 && (
          <div
            className="flex items-center gap-2 mx-5 mt-3 px-3 py-2 rounded-[8px]"
            style={{ background: 'var(--color-accent-light)', border: '1px solid var(--color-glass-border)' }}
          >
            <span className="text-[12px]" style={{ color: 'var(--color-accent)' }}>已选 {checked.size} 条</span>
            <div className="flex-1" />
            <Button size="sm" variant="secondary" onClick={() => { setCopyTarget(''); setCopyModal({ caseIds: checkedList }); }}>
              <Icon name="copy" size={12} />
              批量复制
            </Button>
            <Button size="sm" variant="secondary" onClick={() => { setPlanTarget(''); setPlanModal({ caseIds: checkedList }); }}>
              <Icon name="play" size={12} />
              加入计划
            </Button>
            <Button size="sm" variant="plain" onClick={() => setChecked(new Set())}>取消选择</Button>
          </div>
        )}

        <div
          className="flex-1 min-h-0 mx-5 my-4 flex flex-col rounded-[12px] overflow-hidden"
          style={{ background: 'var(--color-background-elevated)', border: '1px solid var(--color-glass-border)', boxShadow: 'var(--shadow-card)' }}
        >
          {casesLoading ? (
            <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)', fontSize: 13 }}>
              <Icon name="loader" size={16} className="animate-spin" />
              <span style={{ marginLeft: 8 }}>加载中...</span>
            </div>
          ) : rows.length === 0 ? (
            <EmptyState icon="beaker" title="还没有用例" description="到需求详情页，用 AI 从需求生成用例。" />
          ) : (
            <>
              <div className={`grid ${GRID_COLS} items-center px-5 py-[10px] shrink-0 gap-2`} style={{ background: 'var(--color-background-subtle)', borderBottom: '1px solid var(--color-border)' }}>
                <input type="checkbox" checked={allChecked} onChange={toggleAll} aria-label="全选" />
                <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>优先级</span>
                <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>标题</span>
                <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>所属分组</span>
                <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>状态</span>
                <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>更新时间</span>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto">
                {rows.map((c) => (
                  <div
                    key={c.id}
                    className={`group grid ${GRID_COLS} items-center px-5 py-[12px] gap-2 list-row-clickable`}
                    style={{ borderBottom: '1px solid var(--color-muted)' }}
                    onClick={() => navigate(`/p/${projectId}/cases/${c.id}`)}
                  >
                    <input
                      type="checkbox"
                      checked={checked.has(c.id)}
                      onChange={() => toggleOne(c.id)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`选择 ${c.title}`}
                    />
                    <span><PriorityBadge priority={c.priority} /></span>
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--color-foreground)' }}>{c.title}</span>
                      <span className="hidden group-hover:inline-flex" onClick={(e) => e.stopPropagation()}>
                        <button
                          title="复制"
                          onClick={() => { setCopyTarget(''); setCopyModal({ caseIds: [c.id] }); }}
                          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-foreground-muted)', padding: 2 }}
                        >
                          <Icon name="copy" size={12} />
                        </button>
                        <button
                          title="删除"
                          onClick={() => setConfirmDeleteCase({ id: c.id, title: c.title })}
                          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-destructive)', padding: 2 }}
                        >
                          <Icon name="trash" size={12} />
                        </button>
                      </span>
                    </span>
                    <span className="text-[12px] truncate" style={{ color: 'var(--color-foreground-secondary)' }}>
                      {c.groupId ? (groupName.get(c.groupId) ?? '-') : '-'}
                    </span>
                    <span><StatusPill status={c.status}>{c.status}</StatusPill></span>
                    <span className="text-[11px] font-mono" style={{ color: 'var(--color-foreground-muted)' }} title={c.updatedAt}>
                      {c.updatedAt ? shortDateTime(c.updatedAt) : '-'}
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

      {/* 分组弹窗（新建/重命名/默认域名） */}
      <Dialog open={groupForm.open} onOpenChange={(open) => setGroupForm((f) => ({ ...f, open }))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {groupForm.mode === 'create' ? '新建分组' : groupForm.mode === 'edit' ? '重命名分组' : '分组默认域名'}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            {groupForm.mode !== 'url' && (
              <Input label="名称" placeholder="如：登录与账号" value={groupForm.name} onChange={(e) => setGroupForm((f) => ({ ...f, name: e.target.value }))} />
            )}
            <Input
              label="默认域名（可空）"
              placeholder="https://example.com"
              value={groupForm.defaultUrl}
              onChange={(e) => setGroupForm((f) => ({ ...f, defaultUrl: e.target.value }))}
            />
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <Button variant="plain" onClick={() => setGroupForm(EMPTY_GROUP_FORM)}>取消</Button>
            <Button
              disabled={(groupForm.mode !== 'url' && !groupForm.name.trim()) || saveGroup.isPending}
              onClick={() => saveGroup.mutate()}
            >
              {saveGroup.isPending ? '保存中...' : '保存'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 删除分组确认 */}
      <Dialog open={!!confirmDeleteGroup} onOpenChange={(open) => { if (!open) setConfirmDeleteGroup(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>删除分组</DialogTitle></DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--color-foreground-secondary)' }}>
            确定删除「{confirmDeleteGroup?.name}」？分组内存在用例时将被拒绝删除。
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <Button variant="plain" onClick={() => setConfirmDeleteGroup(null)}>取消</Button>
            <Button variant="danger" disabled={deleteGroup.isPending} onClick={() => confirmDeleteGroup && deleteGroup.mutate(confirmDeleteGroup.id)}>
              {deleteGroup.isPending ? '删除中...' : '确认删除'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 删除用例确认 */}
      <Dialog open={!!confirmDeleteCase} onOpenChange={(open) => { if (!open) setConfirmDeleteCase(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>删除用例</DialogTitle></DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--color-foreground-secondary)' }}>
            确定删除「{confirmDeleteCase?.title}」？该用例的步骤与报告将一并删除。
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <Button variant="plain" onClick={() => setConfirmDeleteCase(null)}>取消</Button>
            <Button variant="danger" disabled={deleteCase.isPending} onClick={() => confirmDeleteCase && deleteCase.mutate(confirmDeleteCase.id)}>
              {deleteCase.isPending ? '删除中...' : '确认删除'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 复制目标分组弹窗 */}
      <Dialog open={!!copyModal} onOpenChange={(open) => { if (!open) setCopyModal(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>复制用例（{copyModal?.caseIds.length} 条）</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-foreground-secondary)' }}>目标分组</label>
            <select className="input-base" value={copyTarget} onChange={(e) => setCopyTarget(e.target.value)}>
              <option value="">请选择</option>
              {(groups ?? []).map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
            <p className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
              副本命名：原名 +「副本」，重名自动追加数字（副本1、副本2…）。
            </p>
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <Button variant="plain" onClick={() => setCopyModal(null)}>取消</Button>
            <Button
              disabled={!copyTarget || copyCases.isPending}
              onClick={() => copyModal && copyCases.mutate({ caseIds: copyModal.caseIds, targetGroupId: copyTarget })}
            >
              {copyCases.isPending ? '复制中...' : '复制'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 加入计划弹窗 */}
      <Dialog open={!!planModal} onOpenChange={(open) => { if (!open) setPlanModal(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>加入执行计划（{planModal?.caseIds.length} 条）</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-foreground-secondary)' }}>选择计划</label>
            <select className="input-base" value={planTarget} onChange={(e) => setPlanTarget(e.target.value)}>
              <option value="">请选择</option>
              {(plans ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.name}{p.environment ? `（${p.environment}）` : ''}</option>
              ))}
            </select>
            {(plans ?? []).length === 0 && (
              <p className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
                还没有执行计划，请先到「执行计划」页创建。
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <Button variant="plain" onClick={() => setPlanModal(null)}>取消</Button>
            <Button
              disabled={!planTarget || addToPlan.isPending}
              onClick={() => planModal && addToPlan.mutate({ caseIds: planModal.caseIds, planId: planTarget })}
            >
              {addToPlan.isPending ? '添加中...' : '加入'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
