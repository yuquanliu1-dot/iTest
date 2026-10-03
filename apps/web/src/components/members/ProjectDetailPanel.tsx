import { useEffect, useState } from 'react';
import { useUIStore } from '../../stores/ui';
import { api, type Project, type AssignedUser, type UserSummary } from '../../api/client';
import { useProjectStore } from '../../stores/project';
import { useAuthStore } from '../../stores/auth';
import { sortByPath } from '../../utils/orgTree';
import MoveProjectModal from './MoveProjectModal';

interface Props { projectId: string; currentOrgId: string; onBack: () => void }

const PAGE_SIZE = 10;

export default function ProjectDetailPanel({ projectId, currentOrgId, onBack }: Props) {
  const toast = useUIStore((s) => s.showToast);
  const organizations = useAuthStore((s) => s.organizations);
  const [project, setProject] = useState<Project | null>(null);
  const [assigned, setAssigned] = useState<AssignedUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  const [moving, setMoving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [candidateQ, setCandidateQ] = useState('');
  const [candidates, setCandidates] = useState<UserSummary[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [candidateLoading, setCandidateLoading] = useState(false);

  const openAdd = () => { setCandidateQ(''); setCandidates([]); setPicked(new Set()); setAdding(true); };
  const closeAdd = () => { setAdding(false); setCandidateQ(''); setCandidates([]); setPicked(new Set()); };

  useEffect(() => {
    let stale = false;
    setAssigned([]); setTotal(0);
    api.projects.assignments(projectId, { page, limit: PAGE_SIZE })
      .then((res) => { if (!stale) { setAssigned(res.items); setTotal(res.total); } })
      .catch(() => { if (!stale) { setAssigned([]); setTotal(0); } });
    return () => { stale = true; };
  }, [projectId, page]);

  useEffect(() => {
    let stale = false;
    setProject(null);
    api.projects.get(projectId)
      .then((p) => { if (!stale) setProject(p); })
      .catch(() => { if (!stale) setProject(null); });
    return () => { stale = true; };
  }, [projectId]);

  useEffect(() => {
    if (!adding) return;
    setCandidateLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await api.users.list({ q: candidateQ || undefined, page: 1, limit: 50 });
        if (!adding) return;
        const assignedIds = new Set(assigned.map((a) => a.userId));
        setCandidates(res.items.filter((u) => !assignedIds.has(u.id)));
      } catch {
        setCandidates([]);
      } finally {
        setCandidateLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [adding, candidateQ, assigned]);

  const togglePick = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const submitBatch = async () => {
    if (picked.size === 0) return;
    setSubmitting(true);
    try {
      await api.projects.assignUsers(projectId, [...picked]);
      toast(`已分配 ${picked.size} 人`, 'success');
      closeAdd();
      api.projects.assignments(projectId, { page, limit: PAGE_SIZE })
        .then((res) => { setAssigned(res.items); setTotal(res.total); })
        .catch(() => {});
    } catch (e) {
      toast(e instanceof Error ? e.message : '操作失败', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const removeOne = async (userId: string) => {
    try {
      await api.projects.unassignUser(projectId, userId);
      api.projects.assignments(projectId, { page, limit: PAGE_SIZE })
        .then((res) => { setAssigned(res.items); setTotal(res.total); })
        .catch(() => {});
    } catch (e) {
      toast(e instanceof Error ? e.message : '操作失败', 'error');
    }
  };

  const assignedPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const choices = sortByPath(organizations.filter((o) => o.isManager));

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center gap-2" style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-glass-border)' }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', fontSize: 13 }}>‹ 返回</button>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-foreground)' }}>{project?.name ?? ''}</span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        <div style={{ border: '1px solid var(--color-glass-border)', borderRadius: 'var(--radius-md)', marginBottom: 12, padding: 12 }}>
          <div className="flex items-center gap-2">
            <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-foreground)' }}>{project?.name ?? ''}</span>
            <span style={{ fontSize: 12, color: 'var(--color-foreground-muted)' }}>已分配 {total}</span>
            {project && (
              <button
                className="text-[11px]"
                style={{ marginLeft: 'auto', padding: '3px 10px', borderRadius: 6, border: '1px solid var(--color-glass-border)', background: 'transparent', color: 'var(--color-foreground-muted)', cursor: 'pointer' }}
                onClick={() => setMoving(true)}
              >
                移动组织
              </button>
            )}
          </div>
        </div>

        <div style={{ border: '1px solid var(--color-glass-border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          <div className="flex items-center gap-2" style={{ padding: '6px 10px', background: 'var(--color-background)' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-foreground-muted)', flex: 1 }}>已分配用户（{total}）</span>
            <button
              className="text-[11px]"
              style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid var(--color-accent)', background: 'transparent', color: 'var(--color-accent)', cursor: 'pointer' }}
              onClick={openAdd}
            >
              + 批量添加
            </button>
          </div>

          <div style={{ padding: '4px 8px' }}>
            {assigned.length === 0 ? (
              <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: 'var(--color-foreground-disabled)' }}>暂无已分配用户</div>
            ) : assigned.map((a) => (
              <div key={a.userId} className="flex items-center gap-2" style={{ padding: '6px 4px', fontSize: 13 }}>
                <span className="truncate" style={{ flex: 1, color: 'var(--color-foreground)' }}>
                  {a.displayName ?? a.username} <span style={{ color: 'var(--color-foreground-disabled)' }}>@{a.username}</span>
                </span>
                <button className="text-[11px]" style={{ padding: '2px 8px', borderRadius: 6, border: '1px solid var(--color-glass-border)', background: 'transparent', color: 'var(--color-foreground-muted)', cursor: 'pointer' }} onClick={() => void removeOne(a.userId)}>
                  移出
                </button>
              </div>
            ))}
          </div>

          {assignedPages > 1 && (
            <div className="flex items-center justify-center gap-3" style={{ padding: '8px 16px', borderTop: '1px solid var(--color-glass-border)', fontSize: 12, color: 'var(--color-foreground-disabled)' }}>
              <button disabled={page <= 1} onClick={() => setPage(page - 1)} style={{ border: 'none', background: 'none', cursor: page <= 1 ? 'default' : 'pointer', color: page <= 1 ? 'var(--color-foreground-disabled)' : 'var(--color-accent)' }}>←</button>
              <span>{page} / {assignedPages}</span>
              <button disabled={page >= assignedPages} onClick={() => setPage(page + 1)} style={{ border: 'none', background: 'none', cursor: page >= assignedPages ? 'default' : 'pointer', color: page >= assignedPages ? 'var(--color-foreground-disabled)' : 'var(--color-accent)' }}>→</button>
            </div>
          )}
        </div>
      </div>

      {adding && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={(e) => { if (e.target === e.currentTarget) closeAdd(); }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--color-surface-overlay)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: 16, width: 480, maxWidth: 'calc(100vw - 32px)' }}>
            <h2 style={{ margin: 0, marginBottom: 12, fontSize: 15, fontWeight: 600 }}>批量添加用户</h2>
            <input value={candidateQ} onChange={(e) => setCandidateQ(e.target.value)} placeholder="搜索用户…" className="input-base input-sm" />
            <div style={{ maxHeight: 300, overflowY: 'auto', marginTop: 8, minHeight: 120 }}>
              {candidateLoading ? (
                <div style={{ padding: 12, textAlign: 'center', fontSize: 12, color: 'var(--color-foreground-disabled)' }}>搜索中…</div>
              ) : candidates.length === 0 ? (
                <div style={{ padding: 12, textAlign: 'center', fontSize: 12, color: 'var(--color-foreground-disabled)' }}>无可添加的用户</div>
              ) : candidates.map((u) => (
                <label key={u.id} className="flex items-center gap-2" style={{ padding: '6px 2px', fontSize: 13, color: 'var(--color-foreground)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={picked.has(u.id)} onChange={() => togglePick(u.id)} />
                  <span className="truncate">{u.displayName} <span style={{ color: 'var(--color-foreground-disabled)' }}>@{u.username}</span></span>
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-2" style={{ marginTop: 12 }}>
              <button onClick={closeAdd} disabled={submitting} style={{ padding: '6px 14px', background: 'transparent', border: 'none', color: 'var(--color-foreground-muted)', cursor: 'pointer' }}>取消</button>
              <button onClick={() => void submitBatch()} disabled={picked.size === 0 || submitting} style={{
                padding: '6px 14px', border: 'none', background: 'var(--color-accent)', color: 'var(--color-accent-foreground)', borderRadius: 6,
                cursor: picked.size === 0 || submitting ? 'default' : 'pointer',
                opacity: picked.size === 0 || submitting ? 0.6 : 1,
              }}>{submitting ? '提交中…' : `分配选中 (${picked.size})`}</button>
            </div>
          </div>
        </div>
      )}

      <MoveProjectModal
        visible={moving}
        projectId={projectId}
        projectName={project?.name ?? ''}
        currentOrgId={project?.organizationId ?? currentOrgId}
        choices={choices}
        onClose={() => setMoving(false)}
        onMoved={(updated) => {
          setProject(updated);
          setMoving(false);
          const store = useProjectStore.getState();
          if (store.current?.id === projectId) store.exit();
          toast('已移动', 'success');
        }}
      />
    </div>
  );
}
