import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useUIStore } from '../stores/ui';
import Input from '../components/ui/Input';
import Button from '../components/ui/Button';
import BrandGlyph from '../components/BrandGlyph';
import Icon from '../components/Icon';

/** 与后端 PASSWORD_POLICY 一致（auth.service.ts）。 */
const PASSWORD_HINT = '密码需 10-64 位，且包含大小写字母、数字和特殊字符';

export default function LoginPage() {
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const applyLogin = useAuthStore((s) => s.applyLogin);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // 首登强制改密阶段（passwordChangeToken 一次性、5 分钟有效）
  const [changeToken, setChangeToken] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);

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
    <div
      className="relative flex h-full w-full items-center justify-center overflow-hidden"
      style={{ background: 'var(--background)' }}
    >
      <div
        className="relative z-10 grid w-full max-w-[920px] gap-10 px-6"
        style={{
          gridTemplateColumns: 'minmax(0, 1fr) minmax(320px, 380px)',
        }}
      >
        {/* Hero block — left. Visible only on lg+. */}
        <div className="hidden lg:flex flex-col justify-center fade-up" style={{ animationDelay: '0.05s' }}>
          <div className="flex items-center gap-3">
            <BrandGlyph size={56} animated />
            <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
              <span
                style={{
                  fontSize: 22,
                  fontWeight: 600,
                  color: 'var(--foreground)',
                  letterSpacing: '-0.02em',
                }}
              >
                iTest
              </span>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: 'var(--muted-foreground)',
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                }}
              >
                Console
              </span>
            </div>
          </div>

          <h1
            style={{
              fontSize: 44,
              fontWeight: 600,
              letterSpacing: '-0.03em',
              color: 'var(--foreground)',
              lineHeight: 1.1,
              marginTop: 32,
              maxWidth: 480,
            }}
          >
            把回归测试，交给一个
            <span
              style={{
                background: 'var(--brand-gradient)',
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                color: 'transparent',
                fontStyle: 'italic',
              }}
            >
              &nbsp;可控的 Agent
            </span>
            。
          </h1>

          <p
            style={{
              fontSize: 14,
              lineHeight: 1.6,
              color: 'var(--muted-foreground)',
              marginTop: 18,
              maxWidth: 460,
            }}
          >
            从需求生成用例、浏览器录制回放、计划一键回归。登录后按项目与版本组织你的测试资产。
          </p>

          <ul
            className="mt-8 flex flex-col gap-2 text-[12px]"
            style={{ color: 'var(--muted-foreground)', maxWidth: 460 }}
          >
            <li className="flex items-center gap-2">
              <span
                style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: 'var(--primary)',
                  flexShrink: 0,
                }}
              />
              AI 拆解需求为场景与用例，可绑定 Git 仓库参考真实源码
            </li>
            <li className="flex items-center gap-2">
              <span
                style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: 'var(--info)',
                  flexShrink: 0,
                }}
              />
              浏览器录制转为可编辑步骤，可控 Agent 回放并截图留证
            </li>
            <li className="flex items-center gap-2">
              <span
                style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: 'var(--success)',
                  flexShrink: 0,
                }}
              />
              项目 × 版本管理用例，执行计划一键回归，报告全程可回溯
            </li>
          </ul>
        </div>

        {/* Sign-in card — right. On <lg, spans full width. */}
        <div
          className="bg-card fade-up"
          style={{
            padding: '32px 28px',
            borderRadius: 'var(--radius-md)',
            display: 'flex',
            flexDirection: 'column',
            gap: 18,
            boxShadow: 'var(--shadow-2xl)',
            animationDelay: '0.1s',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="flex items-center gap-2 lg:hidden">
              <BrandGlyph size={28} animated />
              <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--foreground)' }}>
                iTest
              </span>
            </div>
            <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--foreground)', letterSpacing: '-0.01em' }}>
              {changeToken ? '设置新密码' : '登录'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted-foreground)', lineHeight: 1.5 }}>
              {changeToken ? PASSWORD_HINT : '使用组织账号登录自动化测试平台'}
            </div>
          </div>

          {!changeToken ? (
            <form onSubmit={submitLogin} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Input
                label="用户名"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="用户名"
                autoComplete="username"
                name="username"
                autoFocus
              />
              <div className="flex flex-col gap-1">
                <Input
                  label="密码"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="密码"
                  autoComplete="current-password"
                  name="password"
                  trailingIcon={
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? '隐藏密码' : '显示密码'}
                      className="press"
                      style={{
                        background: 'transparent',
                        border: 'none',
                        padding: 4,
                        cursor: 'pointer',
                        display: 'inline-flex',
                        color: 'var(--muted-foreground)',
                      }}
                    >
                      <Icon name={showPassword ? 'eyeOff' : 'eye'} size={14} />
                    </button>
                  }
                />
              </div>
              <Button
                type="submit"
                size="lg"
                disabled={submitting || !username.trim() || !password}
                style={{ width: '100%', marginTop: 4 }}
              >
                {submitting ? '登录中…' : '登录'}
              </Button>
            </form>
          ) : (
            <form onSubmit={submitChangePassword} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Input
                label="新密码"
                type={showNewPassword ? 'text' : 'password'}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="新密码"
                autoComplete="new-password"
                autoFocus
                trailingIcon={
                  <button
                    type="button"
                    onClick={() => setShowNewPassword((v) => !v)}
                    aria-label={showNewPassword ? '隐藏密码' : '显示密码'}
                    className="press"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: 4,
                      cursor: 'pointer',
                      display: 'inline-flex',
                      color: 'var(--muted-foreground)',
                    }}
                  >
                    <Icon name={showNewPassword ? 'eyeOff' : 'eye'} size={14} />
                  </button>
                }
              />
              <Input
                label="确认新密码"
                type={showNewPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="再次输入新密码"
                autoComplete="new-password"
              />
              <Button
                type="submit"
                size="lg"
                disabled={submitting || !newPassword || !confirmPassword}
                style={{ width: '100%', marginTop: 4 }}
              >
                {submitting ? '提交中…' : '确认修改并登录'}
              </Button>
              <button
                type="button"
                onClick={() => {
                  setChangeToken(null);
                  setNewPassword('');
                  setConfirmPassword('');
                }}
                className="press self-center"
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 12,
                  color: 'var(--muted-foreground)',
                  padding: '4px 8px',
                  marginTop: 2,
                }}
              >
                返回重新登录
              </button>
            </form>
          )}
        </div>
      </div>

      {/* Bottom-right build line — single mono token, no decoration text strip. */}
      <div
        className="absolute bottom-4 right-5 font-mono text-[10px] tracking-[0.04em]"
        style={{ color: 'var(--muted-foreground)', zIndex: 1 }}
        aria-hidden
      >
        build · itest-console
      </div>
    </div>
  );
}
