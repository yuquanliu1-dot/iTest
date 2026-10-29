/**
 * 登录用例选择弹窗：搜索 + 单选列表（点行即选定并关闭），风格对齐计划详情「添加用例」弹窗。
 * 候选由页面级 /plans/:id/login-cases 查询下发（本计划项目内的全部用例）。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../Icon';
import Button from '../ui/Button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/Modal';
import type { LoginCaseOption } from './PlanGroupCard';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cases: LoginCaseOption[];
  /** 当前组已选登录用例 id（未选为 null）：列表高亮 + 清除按钮出现条件。 */
  selectedId: string | null;
  /** 选定回传（点行即触发并关闭）；null = 清除选择。 */
  onPick: (caseId: string | null) => void;
}

export default function LoginCasePickerDialog({ open, onOpenChange, cases, selectedId, onPick }: Props) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');

  useEffect(() => {
    if (open) setQ('');
  }, [open]);

  const keyword = q.trim().toLowerCase();
  const list = keyword ? cases.filter((c) => c.title.toLowerCase().includes(keyword)) : cases;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent style={{ maxWidth: 560 }}>
        <DialogHeader>
          <DialogTitle>{t('plans:selectLoginCase')}</DialogTitle>
        </DialogHeader>
        <div className="px-5 py-3">
          <div className="input-wrap">
            <Icon name="search" size={14} className="input-icon" />
            <input
              type="text"
              autoFocus
              placeholder={t('plans:searchCase')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="input-base input-sm input-with-leading"
            />
          </div>
        </div>
        <div className="px-5 pb-4 max-h-[360px] overflow-y-auto flex flex-col gap-1">
          {list.length === 0 ? (
            <div className="text-[12px] py-8 text-center" style={{ color: 'var(--muted-foreground)' }}>
              {keyword ? t('plans:noMatchingCases') : t('plans:noLoginCases')}
            </div>
          ) : (
            list.map((c) => {
              const active = c.id === selectedId;
              return (
                <div
                  key={c.id}
                  className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius-sm)] cursor-pointer hover-card"
                  style={active ? { background: 'var(--primary-soft, var(--muted))', border: '1px solid var(--primary)' } : { border: '1px solid transparent' }}
                  onClick={() => {
                    onPick(c.id);
                    onOpenChange(false);
                  }}
                >
                  <span
                    className="shrink-0 w-4 h-4 rounded-full flex items-center justify-center"
                    style={{ border: `1px solid ${active ? 'var(--primary)' : 'var(--border)'}` }}
                  >
                    {active && <span className="w-2 h-2 rounded-full" style={{ background: 'var(--primary)' }} />}
                  </span>
                  <span className="text-[12px] flex-1 truncate" style={{ color: 'var(--foreground)' }}>{c.title}</span>
                  <span className="text-[10px]" style={{ color: 'var(--muted-foreground)' }}>{c.id.slice(0, 8)}</span>
                </div>
              );
            })
          )}
        </div>
        <DialogFooter>
          {selectedId && (
            <Button
              variant="ghost"
              className="mr-auto"
              onClick={() => {
                onPick(null);
                onOpenChange(false);
              }}
            >
              {t('plans:clearLoginCase')}
            </Button>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('common:cancel')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
