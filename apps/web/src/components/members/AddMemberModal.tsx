import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../stores/ui';
import { api, type UserSummary } from '../../api/client';

interface Props {
  visible: boolean;
  orgId: string;
  orgName: string;
  onClose: () => void;
  onAdded: () => void;
}

/**
 * 把已有用户加入当前组织（manager）。
 * 候选清单：搜索用户名/displayName，结果用户列表（不含已是本组织成员的）。
 */
export default function AddMemberModal({ visible, orgId, orgName, onClose, onAdded }: Props) {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const [q, setQ] = useState('');
  const [candidates, setCandidates] = useState<UserSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<UserSummary | null>(null);
  const [isManager, setIsManager] = useState(false);
  const [isUser, setIsUser] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setQ('');
    setCandidates([]);
    setPicked(null);
    setIsManager(false);
    setIsUser(true);
    setSaving(false);
    setError(null);
  }, [visible]);

  useEffect(() => {
    if (!visible || picked) return;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await api.users.list({ q: q || undefined, excludeOrgId: orgId, page: 1, limit: 20 });
        if (!visible) return;
        setCandidates(res.items);
      } catch {
        setCandidates([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [visible, q, picked, orgId]);

  const handleSubmit = async () => {
    if (!picked || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api.orgs.addMember(orgId, { username: picked.username, isManager, isUser });
      toast(t('members:added', { name: picked.displayName }), 'success');
      onAdded();
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('members:opFailed');
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  const canSubmit = !!picked && (isManager || isUser) && !saving;

  if (!visible) return null;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-2xl)', padding: 16, width: 460, maxWidth: 'calc(100vw - 32px)', maxHeight: '85vh', overflowY: 'auto' }}>
        <h2 style={{ margin: 0, marginBottom: 12, fontSize: 15, fontWeight: 600, color: 'var(--foreground)' }}>{t('members:addMember')}</h2>

        {error && (
          <div style={{ background: 'var(--destructive-soft)', color: 'var(--destructive)', borderRadius: 6, padding: '8px 12px', fontSize: 12, marginBottom: 10 }}>{error}</div>
        )}

        <div style={{ fontSize: 12, color: 'var(--muted-foreground)', marginBottom: 10 }}>{t('members:addMemberJoinOrg', { name: orgName })}</div>

        <input value={q} onChange={(e) => { setQ(e.target.value); setPicked(null); }} placeholder={t('members:searchByNamePlaceholder')} className="input-base input-sm" />

        <div style={{ maxHeight: 220, overflowY: 'auto', marginTop: 8, minHeight: 96 }}>
          {picked ? (
            <label className="flex items-center gap-2" style={{ padding: '6px 2px', fontSize: 13, color: 'var(--foreground)' }}>
              <input type="checkbox" checked readOnly />
              <span className="truncate">{picked.displayName} <span style={{ color: 'var(--muted-foreground)' }}>@{picked.username}</span></span>
            </label>
          ) : searching ? (
            <div style={{ padding: 12, textAlign: 'center', fontSize: 12, color: 'var(--muted-foreground)' }}>{t('members:searching')}</div>
          ) : candidates.length === 0 ? (
            <div style={{ padding: 12, textAlign: 'center', fontSize: 12, color: 'var(--muted-foreground)' }}>{t('members:noCandidates')}</div>
          ) : candidates.map((u) => (
            <label key={u.id} className="flex items-center gap-2" style={{ padding: '6px 2px', fontSize: 13, color: 'var(--foreground)', cursor: 'pointer' }}>
              <input type="checkbox" checked={false} onChange={() => setPicked(u)} />
              <span className="truncate">{u.displayName} <span style={{ color: 'var(--muted-foreground)' }}>@{u.username}</span></span>
            </label>
          ))}
        </div>

        <div className="flex items-center gap-4" style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
          <label className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--muted-foreground)', cursor: 'pointer' }}>
            <input type="checkbox" checked={isManager} onChange={(e) => setIsManager(e.target.checked)} />
            {t('members:roleManager')}
          </label>
          <label className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--muted-foreground)', cursor: 'pointer' }}>
            <input type="checkbox" checked={isUser} onChange={(e) => setIsUser(e.target.checked)} />
            {t('members:roleUser')}
          </label>
          {!isManager && !isUser && (
            <span className="text-[11px]" style={{ color: 'var(--destructive)' }}>{t('members:requireRole')}</span>
          )}
        </div>

        <div className="flex justify-end gap-2" style={{ marginTop: 14 }}>
          <button onClick={onClose} disabled={saving} style={{ padding: '6px 14px', background: 'var(--popover)', border: '1px solid var(--border)', color: 'var(--muted-foreground)', borderRadius: 6, cursor: 'pointer' }}>{t('common:cancel')}</button>
          <button onClick={() => void handleSubmit()} disabled={!canSubmit} style={{
            padding: '6px 14px', border: 'none', background: 'var(--primary)',
            color: 'var(--primary-foreground)', borderRadius: 6,
            cursor: canSubmit ? 'pointer' : 'default', opacity: canSubmit ? 1 : 0.6,
          }}>{saving ? t('members:adding') : t('members:add')}</button>
        </div>
      </div>
    </div>
  );
}
