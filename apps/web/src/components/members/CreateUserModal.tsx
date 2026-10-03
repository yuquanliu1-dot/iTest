import { useEffect, useState } from 'react';
import { useUIStore } from '../../stores/ui';
import { api } from '../../api/client';

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
      setError('用户名长度需 3-32 字符');
      return;
    }
    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{1,30}[a-zA-Z0-9])$/.test(username)) {
      setError('用户名仅允许字母数字 . _ -，且首末必须是字母数字');
      return;
    }
    const email = form.email.trim();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setError('邮箱格式不正确');
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
      const msg = e instanceof Error ? e.message : '操作失败';
      setError(msg);
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
      <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--color-surface-overlay)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-modal)', padding: 16, width: 420, maxWidth: 'calc(100vw - 32px)' }}>
        <h2 style={{ margin: 0, marginBottom: 12, fontSize: 15, fontWeight: 600, color: 'var(--color-foreground)' }}>
          {temporaryPassword ? '用户已创建' : '创建用户'}
        </h2>

        {temporaryPassword ? (
          <>
            <div style={{ background: 'var(--color-success-light)', border: '1px solid var(--color-success-border)', borderRadius: 6, padding: 12, fontSize: 13, color: 'var(--color-success-text)' }}>
              <div>临时密码（仅展示一次，请立即转交给用户）：</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <code style={{ flex: 1, padding: '6px 10px', borderRadius: 6, background: 'var(--color-background)', color: 'var(--color-foreground)', fontFamily: 'var(--font-mono)', fontSize: 13, overflowWrap: 'anywhere' }}>{temporaryPassword}</code>
                <button onClick={copyPassword} style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--color-glass-border)', background: 'transparent', color: 'var(--color-accent)', cursor: 'pointer' }}>复制</button>
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
            <div style={{ fontSize: 12, color: 'var(--color-foreground-muted)', marginBottom: 10 }}>将创建到：{orgName}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <input type="text" value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} placeholder="用户名" maxLength={32} className="input-base" />
              <input type="text" value={form.displayName} onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))} placeholder="显示名" className="input-base" />
              <input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} placeholder="邮箱（可选）" className="input-base" />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
                <button onClick={onClose} disabled={saving} style={{ padding: '6px 14px', background: 'transparent', border: 'none', color: 'var(--color-foreground-muted)', cursor: 'pointer' }}>取消</button>
                <button onClick={() => void handleSubmit()} disabled={saving || !form.username.trim()} style={{
                  padding: '6px 14px', border: 'none', background: 'var(--color-accent)', color: 'var(--color-accent-foreground)', borderRadius: 6,
                  cursor: saving || !form.username.trim() ? 'default' : 'pointer',
                  opacity: saving || !form.username.trim() ? 0.6 : 1,
                }}>{saving ? '创建中…' : '创建'}</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
