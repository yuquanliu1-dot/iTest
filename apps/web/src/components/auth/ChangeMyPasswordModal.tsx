import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
      toast('两次输入的新密码不一致', 'error');
      return;
    }
    if (next.length < MIN_LENGTH || next.length > MAX_LENGTH) {
      toast(`新密码长度需在 ${MIN_LENGTH}-${MAX_LENGTH} 位之间`, 'error');
      return;
    }
    setSubmitting(true);
    try {
      await api.auth.updateMyPassword(current, next);
      clearSession();
      toast('密码已更新，请重新登录', 'success');
      handleClose(false);
      navigate('/login', { replace: true });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>修改密码</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 px-5 py-4">
          <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
            修改成功后所有会话将立即失效，需要重新登录。
          </p>
          <Input
            label="当前密码"
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            size="sm"
          />
          <Input
            label="新密码"
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            size="sm"
          />
          <Input
            label="确认新密码"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            size="sm"
          />
          <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
            至少 {MIN_LENGTH} 位，需包含大小写字母、数字与特殊字符。
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => handleClose(false)} disabled={submitting}>
            取消
          </Button>
          <Button size="sm" onClick={submit} disabled={submitting || !current || !next || !confirm}>
            {submitting ? '提交中…' : '确认修改'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
