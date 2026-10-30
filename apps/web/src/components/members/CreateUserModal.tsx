import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../stores/ui';
import { api } from '../../api/client';
import { copyTextToClipboard } from '../../lib/clipboard';

interface Props {
  visible: boolean;
  orgId: string;
  orgName: string;
  onClose: () => void;
  onCreated: () => void;
}

interface Form {
  username: string;
  displayName: string;
  email: string;
}

/**
 * 创建用户（manager）。后端生成临时密码并强制首登改密，密码只在这个弹窗里出现一次。
 */
export default function CreateUserModal({ visible, orgId, orgName, onClose, onCreated }: Props) {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const [form, setForm] = useState<Form>({ username: '', displayName: '', email: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [temporaryPassword, setTemporaryPassword] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setForm({ username: '', displayName: '', email: '' });
    setError(null);
    setSaving(false);
    setTemporaryPassword(null);
  }, [visible]);

  const handleSubmit = async () => {
    const username = form.username.trim();
    if (!username || saving) return;
    if (username.length < 3 || username.length > 32) {
      setError(t('members:usernameLengthError'));
      return;
    }
    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{1,30}[a-zA-Z0-9])$/.test(username)) {
      setError(t('members:usernameCharsetError'));
      return;
    }
    const email = form.email.trim();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setError(t('members:emailInvalid'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await api.users.create({
        username,
        displayName: form.displayName.trim() || username,
        email: email || undefined,
        organizationId: orgId,
      });
      setTemporaryPassword(res.temporaryPassword);
      onCreated();
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('members:opFailed');
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  const copyPassword = () => {
    if (!temporaryPassword) return;
    void copyTextToClipboard(temporaryPassword).then((ok) =>
      toast(ok ? t('members:copied') : t('members:copyFailed'), ok ? 'success' : 'error'),
    );
  };

  if (!visible) return null;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={(e) => { if (e.target === e.currentTarget && !temporaryPassword) onClose(); }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-2xl)', padding: 16, width: 420, maxWidth: 'calc(100vw - 32px)', maxHeight: '85vh', overflowY: 'auto' }}>
        <h2 style={{ margin: 0, marginBottom: 12, fontSize: 15, fontWeight: 600, color: 'var(--foreground)' }}>
          {temporaryPassword ? t('members:userCreated') : t('members:create')}
        </h2>

        {temporaryPassword ? (
          <>
            <div style={{ background: 'var(--success-soft)', border: '1px solid var(--success-soft-border)', borderRadius: 6, padding: 12, fontSize: 13, color: 'var(--success)' }}>
              <div>{t('members:tempPwdHint')}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <code style={{ flex: 1, padding: '6px 10px', borderRadius: 6, background: 'var(--background)', color: 'var(--foreground)', fontFamily: 'var(--font-mono)', fontSize: 13, overflowWrap: 'anywhere' }}>{temporaryPassword}</code>
                <button onClick={copyPassword} style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--popover)', color: 'var(--primary)', cursor: 'pointer' }}>{t('members:copy')}</button>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button onClick={onClose} style={{ padding: '6px 14px', background: 'var(--primary)', color: 'var(--primary-foreground)', border: 'none', borderRadius: 6, cursor: 'pointer' }}>{t('common:close')}</button>
            </div>
          </>
        ) : (
          <>
            {error && (
              <div style={{ background: 'var(--destructive-soft)', color: 'var(--destructive)', borderRadius: 6, padding: '8px 12px', fontSize: 12, marginBottom: 10 }}>{error}</div>
            )}
            <div style={{ fontSize: 12, color: 'var(--muted-foreground)', marginBottom: 10 }}>{t('members:createIntoOrg', { name: orgName })}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <input type="text" value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} placeholder={t('members:usernamePlaceholder')} maxLength={32} className="input-base" />
              <input type="text" value={form.displayName} onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))} placeholder={t('members:displayNamePlaceholder')} className="input-base" />
              <input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} placeholder={t('members:emailOptionalPlaceholder')} className="input-base" />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
                <button onClick={onClose} disabled={saving} style={{ padding: '6px 14px', background: 'var(--popover)', border: '1px solid var(--border)', color: 'var(--muted-foreground)', borderRadius: 6, cursor: 'pointer' }}>{t('common:cancel')}</button>
                <button onClick={() => void handleSubmit()} disabled={saving || !form.username.trim()} style={{
                  padding: '6px 14px', border: 'none', background: 'var(--primary)', color: 'var(--primary-foreground)', borderRadius: 6,
                  cursor: saving || !form.username.trim() ? 'default' : 'pointer',
                  opacity: saving || !form.username.trim() ? 0.6 : 1,
                }}>{saving ? t('members:creating') : t('members:create')}</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
