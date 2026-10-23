import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { localizeApiError } from '../../i18n';
import { api } from '../../api/client';

interface Props {
  visible: boolean;
  productLineId: string;
  productLineName: string;
  /** 线当前所属组织；候选里排除它（移动到自身没有意义，后端也会 409 same_org）。 */
  currentOrganizationId: string;
  /** 候选组织（调用者对其有管理员权限的 managed-subtree 节点）。 */
  choices: Array<{ id: string; name: string }>;
  onClose: () => void;
  onMoved: () => void;
}

/**
 * 移动产品线到另一个组织（manager）。走 product-lines/:id/move。
 * 后果是一次性的：线内全部项目跟着换组织，标签一并迁移——所以提示文案必须说清楚。
 */
export default function MoveProductLineModal({
  visible,
  productLineId,
  productLineName,
  currentOrganizationId,
  choices,
  onClose,
  onMoved,
}: Props) {
  const { t } = useTranslation();
  const [targetId, setTargetId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setTargetId('');
    setError(null);
    setSaving(false);
  }, [visible]);

  const filtered = choices.filter((o) => o.id !== currentOrganizationId);
  const target = filtered.find((o) => o.id === targetId);

  const handleSubmit = async () => {
    if (!target || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api.productLines.move(productLineId, target.id);
      onMoved();
    } catch (e) {
      setError(e instanceof Error ? localizeApiError(e) : t('members:opFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (!visible) return null;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16, width: 420, maxWidth: 'calc(100vw - 32px)' }}>
        <h2 style={{ margin: 0, marginBottom: 12, fontSize: 15, fontWeight: 600 }}>{t('members:moveLineOrg')}</h2>
        {error && (
          <div style={{ background: 'var(--destructive-soft)', color: 'var(--destructive)', borderRadius: 6, padding: '8px 12px', fontSize: 12, marginBottom: 10 }}>{error}</div>
        )}
        <div style={{ fontSize: 12, color: 'var(--muted-foreground)', marginBottom: 10 }}>{t('members:changeToOrg', { name: productLineName })}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '12px 0', textAlign: 'center', fontSize: 12, color: 'var(--muted-foreground)' }}>
              {t('members:noOrgTargets')}
            </div>
          ) : (
            <select value={targetId} onChange={(e) => setTargetId(e.target.value)} className="input-base">
              <option value="">{t('members:selectTargetOrg')}</option>
              {filtered.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          )}
          <div style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>{t('members:lineMoveOrgHint')}</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
            <button onClick={onClose} disabled={saving} style={{ padding: '6px 14px', background: 'var(--popover)', border: '1px solid var(--border)', color: 'var(--muted-foreground)', borderRadius: 6, cursor: 'pointer' }}>{t('common:cancel')}</button>
            <button onClick={() => void handleSubmit()} disabled={saving || !target} style={{
              padding: '6px 14px', border: 'none', background: 'var(--primary)', color: 'var(--primary-foreground)', borderRadius: 6,
              cursor: saving || !target ? 'default' : 'pointer', opacity: saving || !target ? 0.6 : 1,
            }}>{saving ? t('members:movingLineOrg') : t('members:moveLineOrgTo', { name: target?.name ?? '' })}</button>
          </div>
        </div>
      </div>
    </div>
  );
}