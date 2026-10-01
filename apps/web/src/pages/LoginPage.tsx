import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useUIStore } from '../stores/ui';
import Input from '../components/ui/Input';
import Button from '../components/ui/Button';

/** 与后端 PASSWORD_POLICY 一致（auth.service.ts）。 */
const PASSWORD_HINT = '密码需 10-64 位，且包含大小写字母、数字和特殊字符';

export default function LoginPage() {
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const applyLogin = useAuthStore((s) => s.applyLogin);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 首登强制改密阶段（passwordChangeToken 一次性、5 分钟有效）
  const [changeToken, setChangeToken] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  if (isAuthenticated) return <Navigate to="/" replace />;

  const submitLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password || submitting) return;
    setSubmitting(true);
    try {
      const r = await api.auth.login(username.trim(), password);
      if (r.status === 'password_change_required') {
        setChangeToken(r.passwordChangeToken);
        return;
      }
      await applyLogin(r);
      navigate('/', { replace: true });
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const submitChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (newPassword !== confirmPassword) {
      toast('两次输入的新密码不一致', 'error');
      return;
    }
    setSubmitting(true);
    try {
      // 改密成功即自动登录（响应同登录 ok 分支，并种下新会话 cookie）
      const r = await api.auth.changePassword(changeToken!, newPassword);
      await applyLogin(r);
      toast('密码已更新', 'success');
      navigate('/', { replace: true });
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center" style={{ background: 'var(--color-background)' }}>
      <div
        className="glass-panel"
        style={{
          width: 360,
          padding: '32px 28px',
          borderRadius: 'var(--radius-lg)',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {/* Logo */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 8,
              background: 'var(--color-accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <span style={{ color: 'white', fontSize: 12, fontWeight: 700, letterSpacing: 0.2 }}>iTest</span>
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-foreground)' }}>
            {changeToken ? '设置新密码' : '登录 iTest'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-foreground-muted)' }}>
            {changeToken ? PASSWORD_HINT : '使用组织账号登录自动化测试平台'}
          </div>
        </div>

        {!changeToken ? (
          <form onSubmit={submitLogin} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Input
              label="用户名"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="用户名"
              autoComplete="username"
              autoFocus
            />
            <Input
              label="密码"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="密码"
              autoComplete="current-password"
            />
            <Button type="submit" size="lg" disabled={submitting || !username.trim() || !password} style={{ width: '100%' }}>
              {submitting ? '登录中…' : '登录'}
            </Button>
          </form>
        ) : (
          <form onSubmit={submitChangePassword} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Input
              label="新密码"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="新密码"
              autoComplete="new-password"
              autoFocus
            />
            <Input
              label="确认新密码"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="再次输入新密码"
              autoComplete="new-password"
            />
            <Button type="submit" size="lg" disabled={submitting || !newPassword || !confirmPassword} style={{ width: '100%' }}>
              {submitting ? '提交中…' : '确认修改并登录'}
            </Button>
            <button
              type="button"
              onClick={() => {
                setChangeToken(null);
                setNewPassword('');
                setConfirmPassword('');
              }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: 'var(--color-foreground-muted)' }}
            >
              返回重新登录
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
