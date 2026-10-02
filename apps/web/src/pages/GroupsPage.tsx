import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type CaseStatus } from '../api/client';
import { useProjectStore } from '../stores/project';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import Card from '../components/ui/Card';
import CaseStatusMenu from '../components/CaseStatusMenu';
import PriorityBadge from '../components/ui/PriorityBadge';
import EmptyState from '../components/ui/EmptyState';
import Pagination from '../components/ui/Pagination';
import Segmented from '../components/ui/Segmented';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/Modal';
import Input from '../components/ui/Input';
import Button from '../components/ui/Button';
import TagChip from '../components/ui/Tag';
import IconButton from '../components/ui/IconButton';
import LabelsManagerDialog from '../components/labels/LabelsManagerDialog';
import { shortDateTime } from '../lib/format';

const PRIORITIES = ['', 'P0', 'P1', 'P2', 'P3'] as const;
const DEFAULT_PAGE_SIZE = 20;
const MAX_TAG_CHIPS = 3;
const GRID_COLS = 'grid-cols-[minmax(28px,32px)_minmax(90px,70px)_minmax(200px,2fr)_minmax(120px,1fr)_minmax(160px,1.1fr)_minmax(160px,1fr)_minmax(90px,0.7fr)_minmax(100px,0.9fr)_minmax(70px,80px)]';

type GroupForm = { open: boolean; mode: 'create' | 'edit' | 'url'; id: string | null; name: string; defaultUrl: string };
const EMPTY_GROUP_FORM: GroupForm = { open: false, mode: 'create', id: null, name: '', defaultUrl: '' };
type AiForm = { open: boolean; title: string; content: string };
type CasePriority = 'P0' | 'P1' | 'P2' | 'P3';
type CaseForm = { open: boolean; title: string; groupId: string; priority: CasePriority; url: string; description: string };
const EMPTY_CASE_FORM: CaseForm = { open: false, title: '', groupId: '', priority: 'P1', url: '', description: '' };

export default function GroupsPage() {
  const { projectId, groupId } = useParams<{ projectId: string; groupId: string }>();
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const current = useProjectStore((s) => s.current);

  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>('');
  const [scenarioId, setScenarioId] = useState<string>('');
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<'' | CaseStatus>('');
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const [labelsManagerOpen, setLabelsManagerOpen] = useState(false);
  const tagPickerRef = useRef<HTMLDivElement>(null);
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
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const [aiForm, setAiForm] = useState<AiForm>({ open: false, title: '', content: '' });
  const [caseForm, setCaseForm] = useState<CaseForm>(EMPTY_CASE_FORM);

  const { data: groups, isLoading: groupsLoading } = useQuery({
    queryKey: ['groups', projectId],
    queryFn: () => api.projects.groups(projectId!),
    enabled: !!projectId,
  });

  const effectiveGroupId = groupId ?? '';
  const { data: cases, isLoading: casesLoading } = useQuery({
    queryKey: ['cases', projectId, effectiveGroupId, priority, scenarioId],
    queryFn: () =>
      api.cases.list(effectiveGroupId
        ? { groupId: effectiveGroupId, priority: priority || undefined, scenarioId: scenarioId || undefined }
        : { projectId: projectId!, priority: priority || undefined, scenarioId: scenarioId || undefined }),
    enabled: !!projectId,
  });

  const { data: plans } = useQuery({
    queryKey: ['plans', projectId],
    queryFn: () => api.projects.plans(projectId!),
    enabled: !!projectId,
  });

  const { data: projectTags } = useQuery({
    queryKey: ['tags', projectId],
    queryFn: () => api.tags.list(projectId!),
    enabled: !!projectId,
  });

  // 场景过滤下拉的选项来源 = 项目级全量场景（来自 /api/scenarios?projectId），
  // 不再依赖当前 cases 列表 dedup，这样选中某个场景后其他选项不会消失。
  const { data: projectScenarios } = useQuery({
    queryKey: ['scenarios', projectId],
    queryFn: () => api.scenarios.listForProject(projectId!),
    enabled: !!projectId,
  });

  const tagById = useMemo(() => new Map((projectTags ?? []).map((t) => [t.id, t])), [projectTags]);

  useEffect(() => {
    if (!tagPickerOpen) return;
    const onClick = (e: MouseEvent) => {
      if (tagPickerRef.current && !tagPickerRef.current.contains(e.target as Node)) setTagPickerOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [tagPickerOpen]);

  const groupName = useMemo(
    () => new Map((groups ?? []).map((g) => [g.id, g.name])),
    [groups],
  );

  // 新建用例的 URL 预填：分组.defaultUrl 优先，回退项目.defaultUrl（与 resolveCaseUrl 链一致）
  const inheritUrl = (gid: string) =>
    (groups ?? []).find((g) => g.id === gid)?.defaultUrl || current?.defaultUrl || '';

  // 场景过滤下拉选项 = 项目下全部 scenario 去重 + 「无场景」sentinel。
  // 「无场景」是否出现，看当前列表里有没有 scenarioId == null 的用例（仅首次观察一次）。
  const scenarioOptions = useMemo(() => {
    const map = new Map<string, { id: string; title: string }>();
    for (const s of projectScenarios ?? []) {
      if (!map.has(s.id)) map.set(s.id, { id: s.id, title: s.title });
    }
    const hasNone = (cases ?? []).some((c) => c.scenarioId == null);
    const opts: Array<{ id: string; title: string }> = [];
    if (hasNone) opts.push({ id: 'none', title: '（无场景）' });
    for (const v of map.values()) opts.push(v);
    return opts;
  }, [projectScenarios, cases]);

  // 切换分组时清空勾选 + 场景过滤
  useEffect(() => {
    setChecked(new Set());
    setPage(1);
    setScenarioId('');
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

  // 行内执行：成功后跳到报告详情，与 CaseDetail 行为一致
  const executeCase = useMutation({
    mutationFn: (id: string) => api.cases.execute(id),
    onSuccess: (r) => {
      toast('执行完成', 'success');
      qc.invalidateQueries({ queryKey: ['reports'] });
      navigate(`/p/${projectId}/reports/${r.reportId}`);
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const batchDeleteCases = useMutation({
    mutationFn: (caseIds: string[]) => api.cases.removeBatch(caseIds),
    onSuccess: (r) => {
      toast(`已删除 ${r.count} 条用例`, 'success');
      setConfirmBatchDelete(false);
      setChecked(new Set());
      invalidate();
    },
    onError: (e: Error) => {
      toast(e.message, 'error');
      setConfirmBatchDelete(false);
    },
  });

  const batchStatus = useMutation({
    mutationFn: (status: CaseStatus) => api.cases.updateStatusBatch([...checked], status),
    onSuccess: (r) => {
      toast(`已更新 ${r.count} 条`, 'success');
      setChecked(new Set());
      setPage(1);
      invalidate();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const filteredCases = useMemo(() => {
    let list = cases ?? [];
    if (tagFilter.size > 0) list = list.filter((c) => (c.tags ?? []).some((t) => tagFilter.has(t.id)));
    if (statusFilter) list = list.filter((c) => c.status === statusFilter);
    return list;
  }, [cases, tagFilter, statusFilter]);

  const rows = useMemo(() => filteredCases.slice((page - 1) * pageSize, page * pageSize), [filteredCases, page, pageSize]);
  const total = filteredCases.length;
  const allChecked = rows.length > 0 && rows.every((c) => checked.has(c.id));

  const createRequirement = useMutation({
    mutationFn: () => api.projects.createRequirement(projectId!, { title: aiForm.title, content: aiForm.content }),
    onSuccess: (r) => {
      toast('已创建需求，开始 AI 会话', 'success');
      // 把首条需求文本带到工作台；AiWorkspacePage 拿到 threadId 后会自动 POST /messages 启动 AI 跑活。
      const draft = { requirementId: r.id, title: aiForm.title, content: aiForm.content };
      setAiForm({ open: false, title: '', content: '' });
      navigate(`/p/${projectId}/ai/${r.id}`, { state: { initialMessage: aiForm.content, requirement: draft } });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  // 手动新建用例：成功后跳到详情页继续编辑步骤
  const createCase = useMutation({
    mutationFn: () =>
      api.cases.create({
        title: caseForm.title.trim(),
        groupId: caseForm.groupId,
        priority: caseForm.priority,
        url: caseForm.url.trim() || undefined,
        description: caseForm.description.trim() || undefined,
      }),
    onSuccess: (r) => {
      toast('用例已创建', 'success');
      setCaseForm(EMPTY_CASE_FORM);
      invalidate();
      navigate(`/p/${projectId}/cases/${r.id}`);
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

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
          data-active={!effectiveGroupId || undefined}
          onClick={() => navigate(`/p/${projectId}/groups`)}
          className="group-nav-item text-left px-2 py-1.5 rounded-[6px] text-[13px]"
          style={{
            color: !effectiveGroupId ? 'var(--color-accent)' : 'var(--color-foreground-secondary)',
            fontWeight: !effectiveGroupId ? 500 : 400,
            border: 'none', cursor: 'pointer',
          }}
        >
          全部用例（{cases?.length ?? 0}）
        </button>

        {groupsLoading ? (
          <div className="flex justify-center py-4" style={{ color: 'var(--color-foreground-muted)' }}>
            <Icon name="loader" size={14} className="animate-spin" />
          </div>
        ) : (
          (groups ?? []).map((g) => {
            const active = effectiveGroupId === g.id;
            return (
              <div
                key={g.id}
                data-active={active || undefined}
                onClick={() => navigate(`/p/${projectId}/groups/${g.id}`)}
                className="group-nav-item group flex items-center gap-1 px-2 py-1.5 rounded-[6px] cursor-pointer"
              >
                <Icon name="gitBranch" size={12} style={{ color: 'var(--color-foreground-muted)', flexShrink: 0 }} />
                <span
                  className="flex-1 truncate text-[13px]"
                  style={{ color: active ? 'var(--color-accent)' : 'var(--color-foreground-secondary)', fontWeight: active ? 500 : 400 }}
                  title={g.defaultUrl ?? undefined}
                >
                  {g.name}
                </span>
                <span className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>{g.caseCount}</span>
                <span className="hidden group-hover:flex items-center" onClick={(e) => e.stopPropagation()}>
                  <IconButton
                    icon="pencil"
                    title="重命名"
                    onClick={() => setGroupForm({ open: true, mode: 'edit', id: g.id, name: g.name, defaultUrl: g.defaultUrl ?? '' })}
                  />
                  <IconButton
                    icon="externalLink"
                    title="默认域名"
                    onClick={() => setGroupForm({ open: true, mode: 'url', id: g.id, name: g.name, defaultUrl: g.defaultUrl ?? '' })}
                  />
                  <IconButton
                    icon="trash"
                    title="删除分组"
                    tone="destructive"
                    onClick={() => setConfirmDeleteGroup({ id: g.id, name: g.name })}
                  />
                </span>
              </div>
            );
          })
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
          <div className="flex items-center gap-3">
            <Button
              onClick={() => {
                const gid = effectiveGroupId || groups?.[0]?.id || '';
                setCaseForm({ ...EMPTY_CASE_FORM, open: true, groupId: gid, url: inheritUrl(gid) });
              }}
            >
              <Icon name="plus" size={12} />
              新建用例
            </Button>
            <Button onClick={() => setAiForm({ open: true, title: '', content: '' })}>
              <Icon name="bolt" size={12} />
              AI 创建用例
            </Button>
            <Segmented
              options={PRIORITIES.map((p) => ({ value: p, label: p || '全部' }))}
              value={priority}
              onChange={(v) => { setPriority(v); setPage(1); }}
            />
            <select
              aria-label="场景过滤"
              value={scenarioId}
              onChange={(e) => { setScenarioId(e.target.value); setPage(1); }}
              disabled={scenarioOptions.length === 0}
              className="text-[12px] rounded-md px-2 py-1 outline-none"
              style={{
                border: '1px solid var(--color-border)',
                background: 'var(--color-background-elevated)',
                color: 'var(--color-foreground)',
                minWidth: 140,
              }}
            >
              <option value="">全部场景</option>
              {scenarioOptions.map((o) => (
                <option key={o.id} value={o.id}>{o.title}</option>
              ))}
            </select>
            <select
              aria-label="状态过滤"
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value as '' | CaseStatus); setPage(1); }}
              className="text-[12px] rounded-md px-2 py-1 outline-none"
              style={{
                border: '1px solid var(--color-border)',
                background: 'var(--color-background-elevated)',
                color: 'var(--color-foreground)',
                minWidth: 140,
              }}
              title="按状态过滤"
            >
              <option value="">全部状态</option>
              <option value="draft">草稿</option>
              <option value="review">评审中</option>
              <option value="ready">就绪</option>
              <option value="deprecated">废弃</option>
            </select>
            <div className="relative" ref={tagPickerRef}>
              <button
                type="button"
                onClick={() => setTagPickerOpen((v) => !v)}
                className="flex items-center gap-1.5 text-[12px] rounded-md px-2 py-1"
                style={{
                  border: '1px solid var(--color-border)',
                  background: 'var(--color-background-elevated)',
                  color: 'var(--color-foreground)',
                  minWidth: 140,
                  cursor: 'pointer',
                }}
                title="按标签过滤"
              >
                {tagFilter.size === 0 ? (
                  <span style={{ color: 'var(--color-foreground-muted)' }}>全部标签</span>
                ) : (
                  <span className="flex items-center gap-1 truncate">
                    {[...tagFilter].slice(0, 2).map((id) => {
                      const t = tagById.get(id);
                      if (!t) return null;
                      return <TagChip key={id} tag={t} />;
                    })}
                    {tagFilter.size > 2 && (
                      <span className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>+{tagFilter.size - 2}</span>
                    )}
                  </span>
                )}
                <Icon name="chevronDown" size={10} style={{ color: 'var(--color-foreground-muted)' }} />
              </button>
              {tagPickerOpen && (
                <div
                  className="absolute right-0 top-full mt-1 z-50 rounded-[8px] overflow-hidden popover-in"
                  style={{
                    width: 220,
                    border: '1px solid var(--color-glass-border)',
                    background: 'var(--color-background-elevated)',
                    boxShadow: 'var(--shadow-middle)',
                  }}
                >
                  <div className="max-h-56 overflow-y-auto py-1">
                    {(projectTags ?? []).length === 0 ? (
                      <div className="px-3 py-2 text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>
                        项目内还没有标签
                      </div>
                    ) : (
                      (projectTags ?? []).map((t) => {
                        const checked = tagFilter.has(t.id);
                        return (
                          <label
                            key={t.id}
                            className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-[var(--color-background-subtle)]"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => {
                                const next = new Set(tagFilter);
                                if (checked) next.delete(t.id);
                                else next.add(t.id);
                                setTagFilter(next);
                                setPage(1);
                              }}
                              className="w-3.5 h-3.5 rounded-[3px]"
                              style={{ accentColor: 'var(--color-accent)' }}
                            />
                            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: `#${t.color}` }} />
                            <span className="text-[12px] truncate" style={{ color: 'var(--color-foreground)' }}>{t.name}</span>
                          </label>
                        );
                      })
                    )}
                  </div>
                  <div className="flex items-center justify-between px-3 py-1.5 border-t" style={{ borderColor: 'var(--color-border)' }}>
                    <button
                      type="button"
                      className="text-[11px] cursor-pointer"
                      style={{ background: 'transparent', border: 'none', color: tagFilter.size === 0 ? 'var(--color-foreground-muted)' : 'var(--color-accent)', opacity: tagFilter.size === 0 ? 0.5 : 1 }}
                      disabled={tagFilter.size === 0}
                      onClick={() => { setTagFilter(new Set()); setPage(1); }}
                    >
                      清空
                    </button>
                    <button
                      type="button"
                      className="text-[11px] cursor-pointer"
                      style={{ background: 'transparent', border: 'none', color: 'var(--color-accent)' }}
                      onClick={() => { setTagPickerOpen(false); setLabelsManagerOpen(true); }}
                    >
                      管理标签 →
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
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
            <select
              aria-label="批量修改状态"
              className="text-[12px] rounded-md px-2 py-1 outline-none"
              value=""
              disabled={batchStatus.isPending}
              onChange={(e) => {
                if (e.target.value) batchStatus.mutate(e.target.value as CaseStatus);
              }}
              style={{
                border: '1px solid var(--color-border)',
                background: 'var(--color-background-elevated)',
                color: 'var(--color-foreground)',
                cursor: 'pointer',
              }}
              title="批量修改选中用例状态"
            >
              <option value="">改状态…</option>
              <option value="draft">→ 草稿</option>
              <option value="review">→ 评审中</option>
              <option value="ready">→ 就绪</option>
              <option value="deprecated">→ 废弃</option>
            </select>
            <Button size="sm" variant="danger" onClick={() => setConfirmBatchDelete(true)}>
              <Icon name="trash" size={12} />
              批量删除
            </Button>
            <Button size="sm" variant="plain" onClick={() => setChecked(new Set())}>取消选择</Button>
          </div>
        )}

        <Card padding="none" className="flex-1 min-h-0 mx-5 my-4 flex flex-col overflow-hidden">
          {casesLoading ? (
            <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)', fontSize: 13 }}>
              <Icon name="loader" size={16} className="animate-spin" />
              <span style={{ marginLeft: 8 }}>加载中...</span>
            </div>
          ) : rows.length === 0 ? (
            <EmptyState icon="beaker" title="还没有用例" description="点击右上角「AI 创建用例」，粘贴需求让 AI 生成。" />
          ) : (
            <>
              <div className={`grid ${GRID_COLS} items-center px-5 py-[10px] shrink-0 gap-2`} style={{ background: 'var(--color-background-subtle)', borderBottom: '1px solid var(--color-border)' }}>
                <input type="checkbox" checked={allChecked} onChange={toggleAll} aria-label="全选" />
                <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>优先级</span>
                <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>标题</span>
                <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>所属分组</span>
                <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>场景</span>
                <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>标签</span>
                <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>状态</span>
                <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>更新时间</span>
                <span className="text-[11px] font-medium uppercase tracking-[0.03em] text-right" style={{ color: 'var(--color-foreground-muted)' }}>操作</span>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto">
                {rows.map((c) => (
                  <div
                    key={c.id}
                    className={`group grid ${GRID_COLS} items-center px-5 py-[12px] gap-2 list-row-clickable`}
                    style={{ borderBottom: '1px solid var(--color-muted)', opacity: c.status === 'deprecated' ? 0.55 : 1 }}
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
                    <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--color-foreground)' }}>{c.title}</span>
                    <span className="text-[12px] truncate" style={{ color: 'var(--color-foreground-secondary)' }}>
                      {c.groupId ? (groupName.get(c.groupId) ?? '-') : '-'}
                    </span>
                    <span className="text-[12px] truncate" style={{ color: 'var(--color-foreground-muted)' }} title={c.scenarioTitle ?? undefined}>
                      {c.scenarioTitle ?? '-'}
                    </span>
                    <span className="flex items-center gap-1 flex-wrap min-w-0">
                      {(c.tags ?? []).length === 0 ? (
                        <span className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>-</span>
                      ) : (
                        <>
                          {(c.tags ?? []).slice(0, MAX_TAG_CHIPS).map((t) => (
                            <TagChip key={t.id} tag={t} />
                          ))}
                          {(c.tags ?? []).length > MAX_TAG_CHIPS && (
                            <span className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
                              +{(c.tags ?? []).length - MAX_TAG_CHIPS}
                            </span>
                          )}
                        </>
                      )}
                    </span>
                    <span onClick={(e) => e.stopPropagation()}>
                      <CaseStatusMenu caseId={c.id} status={c.status} projectId={projectId} />
                    </span>
                    <span className="text-[11px] font-mono" style={{ color: 'var(--color-foreground-muted)' }} title={c.updatedAt}>
                      {c.updatedAt ? shortDateTime(c.updatedAt) : '-'}
                    </span>
                    <span
                      className="flex items-center justify-end gap-1"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <IconButton
                        icon={executeCase.isPending && executeCase.variables === c.id ? 'loader' : 'play'}
                        title="执行"
                        tone="accent"
                        disabled={executeCase.isPending && executeCase.variables === c.id}
                        onClick={() => executeCase.mutate(c.id)}
                      />
                      <IconButton
                        icon="copy"
                        title="复制"
                        onClick={() => { setCopyTarget(''); setCopyModal({ caseIds: [c.id] }); }}
                      />
                      <IconButton
                        icon="trash"
                        title="删除"
                        tone="destructive"
                        onClick={() => setConfirmDeleteCase({ id: c.id, title: c.title })}
                      />
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
          <DialogFooter>
            <Button variant="plain" onClick={() => setConfirmDeleteCase(null)}>取消</Button>
            <Button variant="danger" disabled={deleteCase.isPending} onClick={() => confirmDeleteCase && deleteCase.mutate(confirmDeleteCase.id)}>
              {deleteCase.isPending ? '删除中...' : '确认删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 批量删除确认 */}
      <Dialog open={confirmBatchDelete} onOpenChange={(open) => { if (!open) setConfirmBatchDelete(false); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>批量删除用例</DialogTitle></DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--color-foreground-secondary)' }}>
            确定删除已选的 <span style={{ color: 'var(--color-destructive)', fontWeight: 600 }}>{checked.size}</span> 条用例？这些用例的步骤、报告、附件将被一并删除，且不可恢复。
          </div>
          <DialogFooter>
            <Button variant="plain" onClick={() => setConfirmBatchDelete(false)}>取消</Button>
            <Button
              variant="danger"
              disabled={batchDeleteCases.isPending || checked.size === 0}
              onClick={() => batchDeleteCases.mutate(checkedList)}
            >
              {batchDeleteCases.isPending ? '删除中...' : `删除 ${checked.size} 条`}
            </Button>
          </DialogFooter>
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
          <DialogFooter>
            <Button variant="plain" onClick={() => setCopyModal(null)}>取消</Button>
            <Button
              disabled={!copyTarget || copyCases.isPending}
              onClick={() => copyModal && copyCases.mutate({ caseIds: copyModal.caseIds, targetGroupId: copyTarget })}
            >
              {copyCases.isPending ? '复制中...' : '复制'}
            </Button>
          </DialogFooter>
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
          <DialogFooter>
            <Button variant="plain" onClick={() => setPlanModal(null)}>取消</Button>
            <Button
              disabled={!planTarget || addToPlan.isPending}
              onClick={() => planModal && addToPlan.mutate({ caseIds: planModal.caseIds, planId: planTarget })}
            >
              {addToPlan.isPending ? '添加中...' : '加入'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* AI 创建用例 — 收集需求标题/内容后跳到 AI 工作台 */}
      <Dialog open={aiForm.open} onOpenChange={(open) => setAiForm((f) => ({ ...f, open }))}>
        <DialogContent>
          <DialogHeader><DialogTitle>AI 创建用例</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <p className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>
              描述要测的需求，AI 会基于此生成场景和用例。
            </p>
            <Input
              label="需求标题"
              placeholder="如：登录与账号体系"
              value={aiForm.title}
              onChange={(e) => setAiForm((f) => ({ ...f, title: e.target.value }))}
            />
            <div className="flex flex-col gap-1">
              <label className="text-[12px] font-medium" style={{ color: 'var(--color-foreground-secondary)' }}>
                需求描述
              </label>
              <textarea
                className="input-base"
                rows={6}
                placeholder="把要测的需求贴在这里，AI 会拆解为场景与用例。"
                value={aiForm.content}
                onChange={(e) => setAiForm((f) => ({ ...f, content: e.target.value }))}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <Button variant="plain" onClick={() => setAiForm({ open: false, title: '', content: '' })}>取消</Button>
            <Button
              disabled={!aiForm.title.trim() || !aiForm.content.trim() || createRequirement.isPending}
              onClick={() => createRequirement.mutate()}
            >
              {createRequirement.isPending ? '创建中...' : '开始 AI 会话'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 手动新建用例 */}
      <Dialog open={caseForm.open} onOpenChange={(open) => setCaseForm((f) => ({ ...f, open }))}>
        <DialogContent>
          <DialogHeader><DialogTitle>新建用例</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <Input
              label="标题"
              placeholder="如：登录 - 正确账号密码"
              value={caseForm.title}
              onChange={(e) => setCaseForm((f) => ({ ...f, title: e.target.value }))}
            />
            <div className="flex flex-col gap-1">
              <label className="text-[12px] font-medium" style={{ color: 'var(--color-foreground-secondary)' }}>分组</label>
              <select
                className="input-base"
                value={caseForm.groupId}
                onChange={(e) =>
                  setCaseForm((f) => {
                    // 换分组时：URL 为空或还是上一个分组的继承值 → 重新继承；用户已手输则保留
                    const prev = inheritUrl(f.groupId);
                    return {
                      ...f,
                      groupId: e.target.value,
                      url: !f.url || f.url === prev ? inheritUrl(e.target.value) : f.url,
                    };
                  })
                }
                disabled={(groups ?? []).length === 0}
              >
                {(groups ?? []).length === 0 && <option value="">请先创建分组</option>}
                {(groups ?? []).map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[12px] font-medium" style={{ color: 'var(--color-foreground-secondary)' }}>优先级</label>
              <Segmented
                options={(['P0', 'P1', 'P2', 'P3'] as const).map((p) => ({ value: p, label: p }))}
                value={caseForm.priority}
                onChange={(v) => setCaseForm((f) => ({ ...f, priority: v }))}
              />
            </div>
            <Input
              label="URL（可空）"
              placeholder="https://example.com/login"
              value={caseForm.url}
              onChange={(e) => setCaseForm((f) => ({ ...f, url: e.target.value }))}
            />
            <div className="flex flex-col gap-1">
              <label className="text-[12px] font-medium" style={{ color: 'var(--color-foreground-secondary)' }}>描述（可空）</label>
              <textarea
                className="input-base"
                rows={3}
                placeholder="补充前置条件、测试要点等。"
                value={caseForm.description}
                onChange={(e) => setCaseForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <Button variant="plain" onClick={() => setCaseForm(EMPTY_CASE_FORM)}>取消</Button>
            <Button
              disabled={!caseForm.title.trim() || !caseForm.groupId || createCase.isPending}
              onClick={() => createCase.mutate()}
            >
              {createCase.isPending ? '创建中...' : '创建'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 标签管理弹窗（取代独立 /labels 页） */}
      {projectId && (
        <LabelsManagerDialog
          open={labelsManagerOpen}
          projectId={projectId}
          onClose={() => setLabelsManagerOpen(false)}
        />
      )}
    </div>
  );
}
