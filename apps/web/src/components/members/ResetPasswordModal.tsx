import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../stores/ui';
import { api } from '../../api/client';

interface Props {
  visible: boolean;
  userId: string;
  userName: string;
  onClose: () => void;
}

/**
 * 重置用户密码弹窗。管理员 / 管理者发起，后端生成一次性临时密码 + 强制首登改密。
 */
export default function ResetPasswordModal({ visible, userId, userName, onClose }: Props) {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [temporaryPassword, setTemporaryPassword] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setSaving(false);
    setError(null);
    setTemporaryPassword(null);
  }, [visible]);

  const handleConfirm = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.users.resetPassword(userId);
      setTemporaryPassword(res.temporaryPassword);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('members:opFailed'));
    } finally {
      setSaving(false);
    }
  };

  const copyPassword = () => {
    if (!temporaryPassword) return;
    navigator.clipboard.writeText(temporaryPassword)
      .then(() => toast(t('members:copied'), 'success'))
      .catch(() => toast(t('members:copyFailed'), 'error'));
  };

  if (!visible) return null;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={(e) => { if (e.target === e.currentTarget && !temporaryPassword) onClose(); }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-2xl)', padding: 16, width: 420, maxWidth: 'calc(100vw - 32px)' }}>
        <h2 style={{ margin: 0, marginBottom: 12, fontSize: 15, fontWeight: 600, color: 'var(--foreground)' }}>
          {temporaryPassword ? t('members:pwdReset') : t('members:resetPwd')}
        </h2>

        {temporaryPassword ? (
          <>
            <div style={{ background: 'var(--success-soft)', border: '1px solid var(--success-soft-border)', borderRadius: 6, padding: 12, fontSize: 13, color: 'var(--success)' }}>
              <div>{t('members:tempPwdHintShort')}</div>
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
            <div style={{ fontSize: 13, color: 'var(--foreground)', marginBottom: 12 }}>
              {t('members:resetPwdConfirm', { name: userName })}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={onClose} disabled={saving} style={{ padding: '6px 14px', background: 'var(--popover)', border: '1px solid var(--border)', color: 'var(--muted-foreground)', borderRadius: 6, cursor: 'pointer' }}>{t('common:cancel')}</button>
              <button onClick={() => void handleConfirm()} disabled={saving} style={{
                padding: '6px 14px', background: 'var(--primary)', color: 'var(--primary-foreground)', border: 'none', borderRadius: 6,
                cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1,
              }}>{saving ? t('members:resetting') : t('members:confirmReset')}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
