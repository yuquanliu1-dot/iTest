import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { localizeApiError } from '../../i18n';
import { api } from '../../api/client';
import { useAuthStore } from '../../stores/auth';
import { useUIStore } from '../../stores/ui';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/Modal';
import Input from '../ui/Input';
import Button from '../ui/Button';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const MIN_LENGTH = 10;
const MAX_LENGTH = 64;

/** 自助改密弹窗：走 PATCH /api/auth/me_password。
 *  后端成功后 tokenVersion+1 + clearAuthCookie，所以前端必须清本地会话并跳登录页。 */
export default function ChangeMyPasswordModal({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const clearSession = useAuthStore((s) => s.clearSession);

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setCurrent('');
    setNext('');
    setConfirm('');
  };

  const handleClose = (nextOpen: boolean) => {
    if (submitting) return;
    if (!nextOpen) reset();
    onOpenChange(nextOpen);
  };

  const submit = async () => {
    if (next !== confirm) {
      toast(t('auth:passwordMismatch'), 'error');
      return;
    }
    if (next.length < MIN_LENGTH || next.length > MAX_LENGTH) {
      toast(t('auth:passwordLengthBetween', { min: MIN_LENGTH, max: MAX_LENGTH }), 'error');
      return;
    }
    setSubmitting(true);
    try {
      await api.auth.updateMyPassword(current, next);
      clearSession();
      toast(t('auth:passwordUpdatedAndRelogin'), 'success');
      handleClose(false);
      navigate('/login', { replace: true });
    } catch (e) {
      toast(e instanceof Error ? localizeApiError(e) : String(e), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('auth:changePassword')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 px-5 py-4">
          <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
            {t('auth:changePwdSessionsInvalidated')}
          </p>
          <Input
            label={t('auth:currentPassword')}
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            size="sm"
          />
          <Input
            label={t('auth:newPassword')}
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            size="sm"
          />
          <Input
            label={t('auth:confirmPassword')}
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            size="sm"
          />
          <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
            {t('auth:passwordPolicy', { min: MIN_LENGTH })}
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => handleClose(false)} disabled={submitting}>
            {t('common:cancel')}
          </Button>
          <Button size="sm" onClick={submit} disabled={submitting || !current || !next || !confirm}>
            {submitting ? t('auth:submitting') : t('auth:confirmChange')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
