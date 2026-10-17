import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { localizeApiError } from '../i18n';
import { api } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useUIStore } from '../stores/ui';
import Input from '../components/ui/Input';
import Button from '../components/ui/Button';
import BrandGlyph from '../components/BrandGlyph';
import Icon from '../components/Icon';

/** 密码提示文案与后端 PASSWORD_POLICY 一致（auth.service.ts），见 i18n auth:passwordHint。 */
export default function LoginPage() {
  const { t } = useTranslation();
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
      toast(localizeApiError(err as Error), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const submitChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (newPassword !== confirmPassword) {
      toast(t('auth:passwordMismatch'), 'error');
      return;
    }
    setSubmitting(true);
    try {
      // 改密成功即自动登录（响应同登录 ok 分支，并种下新会话 cookie）
      const r = await api.auth.changePassword(changeToken!, newPassword);
      await applyLogin(r);
      toast(t('auth:passwordUpdated'), 'success');
      navigate('/', { replace: true });
    } catch (err) {
      toast(localizeApiError(err as Error), 'error');
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
            {t('auth:heroLead')}
            <span
              style={{
                background: 'var(--brand-gradient)',
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                color: 'transparent',
                fontStyle: 'italic',
              }}
            >
              &nbsp;{t('auth:heroAgent')}
            </span>
            {t('auth:heroTail')}
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
            {t('auth:heroDescription')}
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
              {t('auth:feature1')}
            </li>
            <li className="flex items-center gap-2">
              <span
                style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: 'var(--info)',
                  flexShrink: 0,
                }}
              />
              {t('auth:feature2')}
            </li>
            <li className="flex items-center gap-2">
              <span
                style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: 'var(--success)',
                  flexShrink: 0,
                }}
              />
              {t('auth:feature3')}
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
            // 不随 grid 行拉伸（左侧 hero 更高）：按内容自适应并垂直居中
            alignSelf: 'center',
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
              {changeToken ? t('auth:setNewPassword') : t('auth:signIn')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted-foreground)', lineHeight: 1.5 }}>
              {changeToken ? t('auth:passwordHint') : t('auth:subtitle')}
            </div>
          </div>

          {!changeToken ? (
            <form onSubmit={submitLogin} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Input
                aria-label={t('auth:username')}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={t('auth:username')}
                autoComplete="username"
                name="username"
                autoFocus
              />
              <Input
                aria-label={t('auth:password')}
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('auth:password')}
                autoComplete="current-password"
                name="password"
                trailingIcon={
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? t('auth:hidePassword') : t('auth:showPassword')}
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
              <Button
                type="submit"
                size="lg"
                disabled={submitting || !username.trim() || !password}
                style={{ width: '100%', marginTop: 4 }}
              >
                {submitting ? t('auth:signingIn') : t('auth:signIn')}
              </Button>
            </form>
          ) : (
            <form onSubmit={submitChangePassword} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Input
                aria-label={t('auth:newPassword')}
                type={showNewPassword ? 'text' : 'password'}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder={t('auth:newPassword')}
                autoComplete="new-password"
                autoFocus
                trailingIcon={
                  <button
                    type="button"
                    onClick={() => setShowNewPassword((v) => !v)}
                    aria-label={showNewPassword ? t('auth:hidePassword') : t('auth:showPassword')}
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
                aria-label={t('auth:confirmPassword')}
                type={showNewPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder={t('auth:confirmPasswordPlaceholder')}
                autoComplete="new-password"
              />
              <Button
                type="submit"
                size="lg"
                disabled={submitting || !newPassword || !confirmPassword}
                style={{ width: '100%', marginTop: 4 }}
              >
                {submitting ? t('auth:submitting') : t('auth:saveAndSignIn')}
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
                {t('auth:backToSignIn')}
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
