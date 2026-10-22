import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { localizeApiError } from '../../i18n';
import { useUIStore } from '../../stores/ui';
import { api, type Project, type AssignedUser, type UserSummary, type ProductLine } from '../../api/client';
import { useProjectStore } from '../../stores/project';
import { useAuthStore } from '../../stores/auth';
import { isManagerOfOrgPath } from '../../utils/orgTree';
import ChangeProductLineModal from './ChangeProductLineModal';

interface Props { projectId: string; onBack: () => void }

const PAGE_SIZE = 10;

export default function ProjectDetailPanel({ projectId, onBack }: Props) {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const organizations = useAuthStore((s) => s.organizations);
  const [project, setProject] = useState<Project | null>(null);
  const [assigned, setAssigned] = useState<AssignedUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  const [changing, setChanging] = useState(false);
  const [lineTargets, setLineTargets] = useState<ProductLine[]>([]);
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
      toast(t('members:assigned', { count: picked.size }), 'success');
      closeAdd();
      api.projects.assignments(projectId, { page, limit: PAGE_SIZE })
        .then((res) => { setAssigned(res.items); setTotal(res.total); })
        .catch(() => {});
    } catch (e) {
      toast(e instanceof Error ? localizeApiError(e) : t('members:opFailed'), 'error');
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
      toast(e instanceof Error ? localizeApiError(e) : t('members:opFailed'), 'error');
    }
  };

  const assignedPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // 变更产品线的候选 = 可见产品线里、其所属组织我确实是 manager 的那些。
  // 产品线只有 organizationId 没有 path，而 authStore.organizations 只含 /auth/me 的直接
  // membership（不含后代组织），所以目标组织 path 从 managed-subtree 取——否则上级管理员
  // 的候选列表为空。后端 POST /product-lines/:id/projects 同样要求「目标产品线所属组织的管理员」，
  // 这里用 isManagerOfOrgPath 与后端 isManagerOfOrg 对齐，避免列出必然 403 的选项。
  useEffect(() => {
    if (!changing) return;
    let stale = false;
    Promise.all([api.productLines.list(), api.orgs.managedSubtree()])
      .then(([lines, orgs]) => {
        if (stale) return;
        setLineTargets(lines.filter((l) => {
          const org = orgs.find((o) => o.id === l.organizationId);
          return !!org && isManagerOfOrgPath(organizations, org.path);
        }));
      })
      .catch(() => {
        if (!stale) setLineTargets([]);
      });
    return () => {
      stale = true;
    };
  }, [changing, organizations]);

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center gap-2" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', fontSize: 13 }}>{t('members:back')}</button>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)' }}>{project?.name ?? ''}</span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', marginBottom: 12, padding: 12 }}>
          <div className="flex items-center gap-2">
            <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--foreground)' }}>{project?.name ?? ''}</span>
            <span style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>{t('members:assignedCount', { count: total })}</span>
            {project && (
              <button
                className="text-[11px]"
                style={{ marginLeft: 'auto', padding: '3px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--popover)', color: 'var(--muted-foreground)', cursor: 'pointer' }}
                onClick={() => setChanging(true)}
              >
                {t('members:changeLine')}
              </button>
            )}
          </div>
        </div>

        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          <div className="flex items-center gap-2" style={{ padding: '6px 10px', background: 'var(--background)' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted-foreground)', flex: 1 }}>{t('members:assignedUsersTitle', { count: total })}</span>
            <button
              className="text-[11px]"
              style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid var(--primary)', background: 'var(--popover)', color: 'var(--primary)', cursor: 'pointer' }}
              onClick={openAdd}
            >
              {t('members:batchAdd')}
            </button>
          </div>

          <div style={{ padding: '4px 8px' }}>
            {assigned.length === 0 ? (
              <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: 'var(--muted-foreground)' }}>{t('members:noAssignedUsers')}</div>
            ) : assigned.map((a) => (
              <div key={a.userId} className="flex items-center gap-2" style={{ padding: '6px 4px', fontSize: 13 }}>
                <span className="truncate" style={{ flex: 1, color: 'var(--foreground)' }}>
                  {a.displayName ?? a.username} <span style={{ color: 'var(--muted-foreground)' }}>@{a.username}</span>
                </span>
                <button className="text-[11px]" style={{ padding: '2px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--popover)', color: 'var(--muted-foreground)', cursor: 'pointer' }} onClick={() => void removeOne(a.userId)}>
                  {t('members:remove')}
                </button>
              </div>
            ))}
          </div>

          {assignedPages > 1 && (
            <div className="flex items-center justify-center gap-3" style={{ padding: '8px 16px', borderTop: '1px solid var(--border)', fontSize: 12, color: 'var(--muted-foreground)' }}>
              <button disabled={page <= 1} onClick={() => setPage(page - 1)} style={{ border: 'none', background: 'none', cursor: page <= 1 ? 'default' : 'pointer', color: page <= 1 ? 'var(--muted-foreground)' : 'var(--primary)' }}>←</button>
              <span>{page} / {assignedPages}</span>
              <button disabled={page >= assignedPages} onClick={() => setPage(page + 1)} style={{ border: 'none', background: 'none', cursor: page >= assignedPages ? 'default' : 'pointer', color: page >= assignedPages ? 'var(--muted-foreground)' : 'var(--primary)' }}>→</button>
            </div>
          )}
        </div>
      </div>

      {adding && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={(e) => { if (e.target === e.currentTarget) closeAdd(); }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16, width: 480, maxWidth: 'calc(100vw - 32px)' }}>
            <h2 style={{ margin: 0, marginBottom: 12, fontSize: 15, fontWeight: 600 }}>{t('members:batchAddUserTitle')}</h2>
            <input value={candidateQ} onChange={(e) => setCandidateQ(e.target.value)} placeholder={t('members:searchUserPlaceholder')} className="input-base input-sm" />
            <div style={{ maxHeight: 300, overflowY: 'auto', marginTop: 8, minHeight: 120 }}>
              {candidateLoading ? (
                <div style={{ padding: 12, textAlign: 'center', fontSize: 12, color: 'var(--muted-foreground)' }}>{t('members:searching')}</div>
              ) : candidates.length === 0 ? (
                <div style={{ padding: 12, textAlign: 'center', fontSize: 12, color: 'var(--muted-foreground)' }}>{t('members:noCandidates')}</div>
              ) : candidates.map((u) => (
                <label key={u.id} className="flex items-center gap-2" style={{ padding: '6px 2px', fontSize: 13, color: 'var(--foreground)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={picked.has(u.id)} onChange={() => togglePick(u.id)} />
                  <span className="truncate">{u.displayName} <span style={{ color: 'var(--muted-foreground)' }}>@{u.username}</span></span>
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-2" style={{ marginTop: 12 }}>
              <button onClick={closeAdd} disabled={submitting} style={{ padding: '6px 14px', background: 'var(--popover)', border: '1px solid var(--border)', color: 'var(--muted-foreground)', borderRadius: 6, cursor: 'pointer' }}>{t('common:cancel')}</button>
              <button onClick={() => void submitBatch()} disabled={picked.size === 0 || submitting} style={{
                padding: '6px 14px', border: 'none', background: 'var(--primary)', color: 'var(--primary-foreground)', borderRadius: 6,
                cursor: picked.size === 0 || submitting ? 'default' : 'pointer',
                opacity: picked.size === 0 || submitting ? 0.6 : 1,
              }}>{submitting ? t('members:submitting') : t('members:assignSelected', { count: picked.size })}</button>
            </div>
          </div>
        </div>
      )}

      <ChangeProductLineModal
        visible={changing}
        projectId={projectId}
        projectName={project?.name ?? ''}
        currentProductLineId={project?.productLineId ?? null}
        choices={lineTargets}
        onClose={() => setChanging(false)}
        onChanged={() => {
          setChanging(false);
          // 项目已迁到新产品线所属组织，可能离开当前可见范围——与原「移动到组织」行为一致。
          const store = useProjectStore.getState();
          if (store.current?.id === projectId) store.exit();
          setProject(null);
          api.projects.get(projectId)
            .then((p) => setProject(p))
            .catch(() => setProject(null));
          toast(t('members:changed'), 'success');
        }}
      />
    </div>
  );
}
