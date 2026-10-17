import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../stores/ui';
import { api, type UserOrgMembership, type UserDetail, type UserProjectSummary } from '../../api/client';
import { useAuthStore } from '../../stores/auth';
import { isManagerOfOrgPath } from '../../utils/orgTree';
import ResetPasswordModal from './ResetPasswordModal';

interface Props { userId: string; onBack: () => void }

export default function UserDetailPanel({ userId, onBack }: Props) {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const myOrganizations = useAuthStore((s) => s.organizations);
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [projects, setProjects] = useState<UserProjectSummary[]>([]);
  const [projectTotal, setProjectTotal] = useState(0);
  const [pendingRemove, setPendingRemove] = useState<UserOrgMembership | null>(null);
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [projectPage, setProjectPage] = useState(1);
  const projectPageSize = 8;

  useEffect(() => {
    let stale = false;
    setDetail(null);
    api.users.get(userId).then((d) => { if (!stale) setDetail(d); }).catch(() => { if (!stale) setDetail(null); });
    return () => { stale = true; };
  }, [userId]);

  useEffect(() => {
    let stale = false;
    api.users.getProjects(userId, { page: projectPage, limit: projectPageSize })
      .then((res) => { if (!stale) { setProjects(res.items); setProjectTotal(res.total); } })
      .catch(() => { if (!stale) { setProjects([]); setProjectTotal(0); } });
    return () => { stale = true; };
  }, [userId, projectPage]);

  if (!detail) {
    return <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted-foreground)', fontSize: 13 }}>{t('common:loading')}</div>;
  }

  const projectPages = Math.max(1, Math.ceil(projectTotal / projectPageSize));
  const isSelf = !!currentUserId && currentUserId === userId;
  const canReset = !isSelf && detail.organizations.some((o) => isManagerOfOrgPath(myOrganizations, o.organizationPath));

  const toggleRole = async (orgId: string, field: 'isManager' | 'isUser', next: boolean) => {
    try {
      await api.orgs.updateMember(orgId, userId, { [field]: next });
      api.users.get(userId).then((d) => setDetail(d)).catch(() => {});
    } catch (e) {
      toast(e instanceof Error ? e.message : t('members:opFailed'), 'error');
    }
  };

  const removeFromOrg = async () => {
    if (!pendingRemove) return;
    try {
      await api.orgs.removeMember(pendingRemove.organizationId, userId);
      toast(t('members:removedFromOrg'), 'success');
      setPendingRemove(null);
      api.users.get(userId).then((d) => setDetail(d)).catch(() => {});
    } catch (e) {
      toast(e instanceof Error ? e.message : t('members:opFailed'), 'error');
      setPendingRemove(null);
    }
  };

  const deleteAccount = async () => {
    try {
      await api.users.remove(userId);
      toast(t('members:accountDeactivated'), 'success');
      setDeleteAccountOpen(false);
      onBack();
    } catch (e) {
      toast(e instanceof Error ? e.message : t('members:opFailed'), 'error');
      setDeleteAccountOpen(false);
    }
  };

  const removeFromProject = async (projectId: string) => {
    try {
      await api.projects.unassignUser(projectId, userId);
      api.users.getProjects(userId, { page: projectPage, limit: projectPageSize })
        .then((res) => { setProjects(res.items); setProjectTotal(res.total); })
        .catch(() => {});
    } catch (e) {
      toast(e instanceof Error ? e.message : t('members:opFailed'), 'error');
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center gap-2" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', fontSize: 13 }}>
          {t('members:back')}
        </button>
        <span style={{ color: 'var(--muted-foreground)', fontSize: 13 }}>
          {detail.displayName}
        </span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        <Card>
          <div className="flex items-center gap-2">
            <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--foreground)' }}>
              {detail.displayName}
            </span>
            <span style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>@{detail.username}</span>
            <button
              className="text-[12px]"
              style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer' }}
              onClick={() => setEditOpen(true)}
            >
              {t('members:edit')}
            </button>
            {canReset && (
              <button className="text-[12px]" style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer' }} onClick={() => setResetOpen(true)}>
                {t('members:resetPwd')}
              </button>
            )}
            <button
              className="text-[12px]"
              disabled={isSelf}
              style={{
                background: 'none', border: 'none', color: 'var(--destructive)',
                cursor: isSelf ? 'default' : 'pointer', opacity: isSelf ? 0.5 : 1,
              }}
              onClick={() => setDeleteAccountOpen(true)}
            >
              {t('members:deleteAccount')}
            </button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted-foreground)', marginTop: 6 }}>
            {detail.email || t('members:noEmail')} {t('members:registeredAt', { date: new Date(detail.createdAt).toLocaleDateString() })}
          </div>
        </Card>

        <Card title={t('members:orgRolesTitle', { count: detail.organizations.length })}>
          {detail.organizations.map((o) => (
            <div key={o.organizationId} className="flex items-center gap-2" style={{ padding: '6px 4px', fontSize: 13 }}>
              <span className="truncate" style={{ flex: 1, color: 'var(--foreground)' }}>{o.organizationName}</span>
              <RoleToggle label={t('members:roleManager')} checked={o.isManager} onChange={(v) => toggleRole(o.organizationId, 'isManager', v)} />
              <RoleToggle label={t('members:roleUserShort')} checked={o.isUser} onChange={(v) => toggleRole(o.organizationId, 'isUser', v)} />
              <button
                className="text-[11px]"
                disabled={isSelf || detail.organizations.length <= 1}
                style={{
                  padding: '2px 8px', borderRadius: 6, border: '1px solid var(--border)',
                  background: 'var(--popover)', color: 'var(--muted-foreground)',
                  cursor: isSelf || detail.organizations.length <= 1 ? 'default' : 'pointer',
                  opacity: isSelf || detail.organizations.length <= 1 ? 0.5 : 1,
                }}
                onClick={() => setPendingRemove(o)}
              >
                {t('members:remove')}
              </button>
            </div>
          ))}
        </Card>

        <Card title={t('members:accessibleProjects', { count: projectTotal })}>
          <div style={{ maxHeight: 220, overflowY: 'auto' }}>
            {projects.length === 0 ? (
              <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: 'var(--muted-foreground)' }}>{t('members:noProjects')}</div>
            ) : projects.map((p) => (
              <div key={p.id} className="flex items-center gap-2" style={{ padding: '6px 4px', fontSize: 13 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="truncate" style={{ color: 'var(--foreground)' }}>{p.name}</div>
                  {p.description && (
                    <div className="truncate" style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>{p.description}</div>
                  )}
                </div>
                <button className="text-[11px]" style={{ padding: '2px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--popover)', color: 'var(--muted-foreground)', cursor: 'pointer' }} onClick={() => void removeFromProject(p.id)}>
                  {t('members:remove')}
                </button>
              </div>
            ))}
          </div>
          {projectPages > 1 && (
            <div className="flex items-center justify-center gap-3" style={{ paddingTop: 8, fontSize: 12, color: 'var(--muted-foreground)' }}>
              <button disabled={projectPage <= 1} onClick={() => setProjectPage(projectPage - 1)} style={{ border: 'none', background: 'none', cursor: projectPage <= 1 ? 'default' : 'pointer', color: projectPage <= 1 ? 'var(--muted-foreground)' : 'var(--primary)' }}>←</button>
              <span>{projectPage} / {projectPages}</span>
              <button disabled={projectPage >= projectPages} onClick={() => setProjectPage(projectPage + 1)} style={{ border: 'none', background: 'none', cursor: projectPage >= projectPages ? 'default' : 'pointer', color: projectPage >= projectPages ? 'var(--muted-foreground)' : 'var(--primary)' }}>→</button>
            </div>
          )}
        </Card>
      </div>

      {pendingRemove && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={(e) => { if (e.target === e.currentTarget) setPendingRemove(null); }}>
          <div style={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16, width: 380, maxWidth: 'calc(100vw - 32px)' }}>
            <h3 style={{ margin: 0, marginBottom: 8, fontSize: 14, fontWeight: 600 }}>{t('members:removeOrgTitle')}</h3>
            <div style={{ fontSize: 13, color: 'var(--muted-foreground)', marginBottom: 12 }}>
              {t('members:removeOrgConfirm', { name: detail.displayName, orgName: pendingRemove.organizationName })}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setPendingRemove(null)} style={{ padding: '6px 12px', background: 'var(--popover)', border: '1px solid var(--border)', color: 'var(--muted-foreground)', borderRadius: 6, cursor: 'pointer' }}>{t('common:cancel')}</button>
              <button onClick={() => void removeFromOrg()} style={{ padding: '6px 12px', background: 'var(--destructive)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>{t('common:confirm')}</button>
            </div>
          </div>
        </div>
      )}

      {deleteAccountOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={(e) => { if (e.target === e.currentTarget) setDeleteAccountOpen(false); }}>
          <div style={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16, width: 380, maxWidth: 'calc(100vw - 32px)' }}>
            <h3 style={{ margin: 0, marginBottom: 8, fontSize: 14, fontWeight: 600 }}>{t('members:deactivateAccountTitle')}</h3>
            <div style={{ fontSize: 13, color: 'var(--muted-foreground)', marginBottom: 12 }}>
              {t('members:deactivateAccountConfirm', { name: detail.displayName })}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setDeleteAccountOpen(false)} style={{ padding: '6px 12px', background: 'var(--popover)', border: '1px solid var(--border)', color: 'var(--muted-foreground)', borderRadius: 6, cursor: 'pointer' }}>{t('common:cancel')}</button>
              <button onClick={() => void deleteAccount()} style={{ padding: '6px 12px', background: 'var(--destructive)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>{t('members:confirmDeactivate')}</button>
            </div>
          </div>
        </div>
      )}

      {editOpen && (
        <EditProfileDialog
          initial={{ displayName: detail.displayName, email: detail.email ?? '' }}
          onClose={() => setEditOpen(false)}
          onSaved={async (vals) => {
            try {
              await api.users.update(userId, { displayName: vals.displayName, email: vals.email || null });
              toast(t('members:saved'), 'success');
              setEditOpen(false);
              api.users.get(userId).then((d) => setDetail(d)).catch(() => {});
            } catch (e) {
              toast(e instanceof Error ? e.message : t('members:saveFailed'), 'error');
            }
          }}
        />
      )}

      <ResetPasswordModal visible={resetOpen} userId={userId} userName={detail.displayName} onClose={() => setResetOpen(false)} />
    </div>
  );
}

function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', marginBottom: 12, overflow: 'hidden' }}>
      {title && (
        <div style={{ padding: '6px 10px', background: 'var(--background)', fontSize: 12, fontWeight: 600, color: 'var(--muted-foreground)' }}>
          {title}
        </div>
      )}
      <div style={{ padding: 10 }}>{children}</div>
    </div>
  );
}

function RoleToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-1 text-[11px]" style={{ color: checked ? 'var(--primary)' : 'var(--muted-foreground)', whiteSpace: 'nowrap', cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function EditProfileDialog({ initial, onClose, onSaved }: { initial: { displayName: string; email: string }; onClose: () => void; onSaved: (vals: { displayName: string; email: string }) => void }) {
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [email, setEmail] = useState(initial.email);
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16, width: 420, maxWidth: 'calc(100vw - 32px)' }}>
        <h3 style={{ margin: 0, marginBottom: 12, fontSize: 14, fontWeight: 600 }}>{t('members:editProfileTitle')}</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={t('members:displayNamePlaceholder')} className="input-base" />
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('members:emailOptional2')} className="input-base" />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
            <button onClick={onClose} style={{ padding: '6px 14px', background: 'var(--popover)', border: '1px solid var(--border)', color: 'var(--muted-foreground)', borderRadius: 6, cursor: 'pointer' }}>{t('common:cancel')}</button>
            <button onClick={() => onSaved({ displayName: displayName.trim(), email: email.trim() })} style={{ padding: '6px 14px', background: 'var(--primary)', color: 'var(--primary-foreground)', border: 'none', borderRadius: 6, cursor: 'pointer' }}>{t('common:save')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
