import { useState, useEffect } from 'react';
import { useUIStore } from '../../stores/ui';
import { api } from '../../api/client';
import { useAuthStore } from '../../stores/auth';
import { pickFallbackOrg, isPathInSubtree, sortByPath } from '../../utils/orgTree';
import OrgFormModal from './OrgFormModal';
import MemberListTab from './MemberListTab';
import ProjectListTab from './ProjectListTab';
import AddMemberModal from './AddMemberModal';
import CreateUserModal from './CreateUserModal';

interface Props {
  orgId: string;
  tab: 'users' | 'projects';
  includeSubtree: boolean;
  q: string;
  page: number;
  pageSize: number;
  onPatchParams: (patch: Record<string, string | null>, replace?: boolean) => void;
  onOpenUser: (id: string) => void;
  onOpenProject: (id: string) => void;
  onOrgChanged: () => void;
  onEditOrg: (org: { id: string; name: string; description?: string; parentId: string | null }) => void;
}

interface OrgDetails {
  id: string;
  name: string;
  description: string | null;
  parentId: string | null;
  path: string;
}

export default function OrgDetailPanel({
  orgId, tab, includeSubtree, q, page, pageSize, onPatchParams, onOpenUser, onOpenProject, onOrgChanged, onEditOrg,
}: Props) {
  const toast = useUIStore((s) => s.showToast);
  const organizations = useAuthStore((s) => s.organizations);
  const activeOrgId = useAuthStore((s) => s.activeOrgId);
  const switchOrg = useAuthStore((s) => s.switchOrg);
  const [memberTotal, setMemberTotal] = useState(0);
  const [projectTotal, setProjectTotal] = useState(0);
  const [orgDetails, setOrgDetails] = useState<OrgDetails | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [createUserOpen, setCreateUserOpen] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [memberReloadToken, setMemberReloadToken] = useState(0);

  useEffect(() => {
    let stale = false;
    api.orgs.get(orgId)
      .then((o) => { if (!stale) setOrgDetails(o as OrgDetails); })
      .catch(() => { if (!stale) setOrgDetails(null); });
    return () => { stale = true; };
  }, [orgId]);

  const orgPath = orgDetails?.path ?? null;
  const canManageMembers = !!orgPath && organizations.some((o) => o.isManager && !!o.path && isPathInSubtree(orgPath, o.path));

  const handleDelete = async () => {
    const wasActive = activeOrgId === orgId;
    const deletedPath = orgDetails?.path ?? null;
    try {
      await api.orgs.remove(orgId);
      toast('组织已删除', 'success');
      setConfirmDelete(false);
      onOrgChanged();
      onPatchParams({ org: null });
      if (wasActive) {
        const fallback = pickFallbackOrg({ id: orgId, path: deletedPath }, organizations);
        if (fallback) {
          try {
            await switchOrg(fallback.id);
          } catch {
            toast('已切换失败，请手动重选', 'error');
          }
        }
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : '操作失败', 'error');
      setConfirmDelete(false);
    }
  };

  const total = tab === 'users' ? memberTotal : projectTotal;
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center gap-2" style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-glass-border)' }}>
        <h2 className="text-[15px] font-semibold truncate" style={{ color: 'var(--color-foreground)' }}>{orgDetails?.name ?? ''}</h2>
        <div className="ml-auto flex gap-2">
          {canManageMembers && (
            <>
              <button
                className="text-[12px]"
                style={{ color: 'var(--color-accent)', background: 'none', border: 'none', cursor: 'pointer' }}
                disabled={!orgDetails}
                onClick={() => { if (orgDetails) {
                  setEditOpen(true);
                  onEditOrg({
                    id: orgDetails.id, name: orgDetails.name,
                    description: orgDetails.description ?? undefined,
                    parentId: orgDetails.parentId,
                  });
                } }}
              >
                编辑
              </button>
              <button
                className="text-[12px]"
                style={{ color: 'var(--color-destructive-text)', background: 'none', border: 'none', cursor: 'pointer' }}
                onClick={() => setConfirmDelete(true)}
              >
                删除
              </button>
            </>
          )}
        </div>
      </div>

      <div className="shrink-0 flex" style={{ borderBottom: '1px solid var(--color-glass-border)' }}>
        <TabButton active={tab === 'users'} onClick={() => onPatchParams({ tab: 'users', page: '1' })}>
          成员 ({memberTotal})
        </TabButton>
        <TabButton active={tab === 'projects'} onClick={() => onPatchParams({ tab: 'projects', page: '1' })}>
          项目 ({projectTotal})
        </TabButton>
      </div>

      <div className="shrink-0 flex items-center gap-2" style={{ padding: '8px 16px', borderBottom: '1px solid var(--color-glass-border)' }}>
        <input
          value={q}
          onChange={(e) => onPatchParams({ q: e.target.value || null, page: '1' })}
          placeholder={tab === 'users' ? '搜索成员' : '搜索项目'}
          className="flex-1 input-base input-sm"
        />
        <label className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--color-foreground-muted)', whiteSpace: 'nowrap', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={includeSubtree}
            onChange={(e) => onPatchParams({ subtree: e.target.checked ? '1' : '0', page: '1' })}
          />
          包含子组织
        </label>
        {tab === 'users' && canManageMembers && (
          <>
            <button
              onClick={() => setAddMemberOpen(true)}
              className="rounded text-[12px]"
              style={{ padding: '4px 10px', whiteSpace: 'nowrap', border: '1px solid var(--color-glass-border)', background: 'transparent', color: 'var(--color-accent)', cursor: 'pointer' }}
            >
              + 添加成员
            </button>
            <button
              onClick={() => setCreateUserOpen(true)}
              className="rounded text-[12px]"
              style={{ padding: '4px 10px', whiteSpace: 'nowrap', border: '1px solid var(--color-glass-border)', background: 'transparent', color: 'var(--color-accent)', cursor: 'pointer' }}
            >
              + 创建用户
            </button>
          </>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px' }}>
        <div style={{ display: tab === 'users' ? 'block' : 'none' }}>
          <MemberListTab orgId={orgId} includeSubtree={includeSubtree} q={q} page={page} pageSize={pageSize}
            reloadToken={memberReloadToken} onTotal={setMemberTotal} onOpen={onOpenUser} />
        </div>
        <div style={{ display: tab === 'projects' ? 'block' : 'none' }}>
          <ProjectListTab orgId={orgId} includeSubtree={includeSubtree} q={q} page={page} pageSize={pageSize}
            onTotal={setProjectTotal} onOpen={onOpenProject} />
        </div>
      </div>

      {totalPages > 1 && (
        <div className="shrink-0 flex items-center justify-center gap-3" style={{ padding: '8px 16px', borderTop: '1px solid var(--color-glass-border)', fontSize: 12, color: 'var(--color-foreground-disabled)' }}>
          <button disabled={page <= 1} onClick={() => onPatchParams({ page: String(page - 1) })} style={pagerBtn(page <= 1)}>←</button>
          <span>{page} / {totalPages}（共 {total}）</span>
          <button disabled={page >= totalPages} onClick={() => onPatchParams({ page: String(page + 1) })} style={pagerBtn(page >= totalPages)}>→</button>
        </div>
      )}

      <AddMemberModal
        visible={addMemberOpen}
        orgId={orgId}
        orgName={orgDetails?.name ?? ''}
        onClose={() => setAddMemberOpen(false)}
        onAdded={() => setMemberReloadToken((v) => v + 1)}
      />

      <CreateUserModal
        visible={createUserOpen}
        orgId={orgId}
        orgName={orgDetails?.name ?? ''}
        onClose={() => setCreateUserOpen(false)}
        onCreated={() => setMemberReloadToken((v) => v + 1)}
      />

      <OrgFormModal
        visible={editOpen}
        org={editOpen && orgDetails ? { id: orgDetails.id, name: orgDetails.name, description: orgDetails.description ?? null, parentId: orgDetails.parentId } : null}
        parentId={null}
        allOrgs={sortByPath(organizations).map((o) => ({ id: o.id, name: o.name, path: o.path ?? '' }))}
        onClose={() => setEditOpen(false)}
        onSaved={() => { setEditOpen(false); onOrgChanged(); }}
      />

      {confirmDelete && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={(e) => { if (e.target === e.currentTarget) setConfirmDelete(false); }}>
          <div style={{ background: 'var(--color-surface-overlay)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-modal)', padding: 16, width: 380, maxWidth: 'calc(100vw - 32px)' }}>
            <h3 style={{ margin: 0, marginBottom: 8, fontSize: 14, fontWeight: 600 }}>删除组织</h3>
            <div style={{ fontSize: 13, color: 'var(--color-foreground-muted)', marginBottom: 12 }}>
              确定删除「{orgDetails?.name}」？子组织或项目非空时会被后端拒删。
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmDelete(false)} style={{ padding: '6px 12px', background: 'transparent', border: 'none', color: 'var(--color-foreground-muted)', cursor: 'pointer' }}>取消</button>
              <button onClick={() => void handleDelete()} style={{ padding: '6px 12px', background: 'var(--color-destructive)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      padding: '8px 16px', fontSize: 13, fontWeight: active ? 600 : 400,
      color: active ? 'var(--color-accent)' : 'var(--color-foreground-muted)',
      background: 'none', border: 'none', borderBottom: `2px solid ${active ? 'var(--color-accent)' : 'transparent'}`,
      cursor: 'pointer', marginBottom: -1,
    }}>{children}</button>
  );
}

function pagerBtn(disabled: boolean): React.CSSProperties {
  return {
    border: 'none', background: 'none', fontSize: 12, padding: '2px 6px',
    cursor: disabled ? 'default' : 'pointer',
    color: disabled ? 'var(--color-foreground-disabled)' : 'var(--color-accent)',
  };
}
