import { useEffect, useState } from 'react';
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
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setSaving(false);
    }
  };

  const copyPassword = () => {
    if (!temporaryPassword) return;
    navigator.clipboard.writeText(temporaryPassword)
      .then(() => toast('已复制', 'success'))
      .catch(() => toast('复制失败', 'error'));
  };

  if (!visible) return null;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={(e) => { if (e.target === e.currentTarget && !temporaryPassword) onClose(); }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--color-surface-overlay)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-modal)', padding: 16, width: 420, maxWidth: 'calc(100vw - 32px)' }}>
        <h2 style={{ margin: 0, marginBottom: 12, fontSize: 15, fontWeight: 600, color: 'var(--color-foreground)' }}>
          {temporaryPassword ? '密码已重置' : '重置密码'}
        </h2>

        {temporaryPassword ? (
          <>
            <div style={{ background: 'var(--color-success-light)', border: '1px solid var(--color-success-border)', borderRadius: 6, padding: 12, fontSize: 13, color: 'var(--color-success-text)' }}>
              <div>临时密码（仅展示一次）：</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <code style={{ flex: 1, padding: '6px 10px', borderRadius: 6, background: 'var(--color-background)', color: 'var(--color-foreground)', fontFamily: 'var(--font-mono)', fontSize: 13, overflowWrap: 'anywhere' }}>{temporaryPassword}</code>
                <button onClick={copyPassword} style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--color-glass-border)', background: 'var(--color-surface-overlay)', color: 'var(--color-accent)', cursor: 'pointer' }}>复制</button>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button onClick={onClose} style={{ padding: '6px 14px', background: 'var(--color-accent)', color: 'var(--color-accent-foreground)', border: 'none', borderRadius: 6, cursor: 'pointer' }}>关闭</button>
            </div>
          </>
        ) : (
          <>
            {error && (
              <div style={{ background: 'var(--color-destructive-light)', color: 'var(--color-destructive)', borderRadius: 6, padding: '8px 12px', fontSize: 12, marginBottom: 10 }}>{error}</div>
            )}
            <div style={{ fontSize: 13, color: 'var(--color-foreground)', marginBottom: 12 }}>
              确定重置「{userName}」的密码？该用户将被迫下线并需重设密码。
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={onClose} disabled={saving} style={{ padding: '6px 14px', background: 'var(--color-surface-overlay)', border: '1px solid var(--color-border)', color: 'var(--color-foreground-muted)', borderRadius: 6, cursor: 'pointer' }}>取消</button>
              <button onClick={() => void handleConfirm()} disabled={saving} style={{
                padding: '6px 14px', background: 'var(--color-accent)', color: 'var(--color-accent-foreground)', border: 'none', borderRadius: 6,
                cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1,
              }}>{saving ? '重置中…' : '确认重置'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
