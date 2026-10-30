import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type ProductLine } from '../../api/client';

interface Props {
  visible: boolean;
  projectId: string;
  projectName: string;
  /** null = 未归线。 */
  currentProductLineId: string | null;
  choices: ProductLine[];
  onClose: () => void;
  onChanged: () => void;
}

/**
 * 变更产品线（manager）。走产品线的挂载接口——挂载即搬家：项目会迁到该产品线所属组织，
 * 项目的标签一并迁移（源组织的旧标签留在原处，目标组织按同名新建/复用）。
 */
export default function ChangeProductLineModal({
  visible,
  projectId,
  projectName,
  currentProductLineId,
  choices,
  onClose,
  onChanged,
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

  const filtered = choices.filter((o) => o.id !== currentProductLineId);
  const target = filtered.find((o) => o.id === targetId);

  const handleSubmit = async () => {
    if (!target || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api.productLines.attachProjects(target.id, [projectId]);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('members:opFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (!visible) return null;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16, width: 420, maxWidth: 'calc(100vw - 32px)', maxHeight: '85vh', overflowY: 'auto' }}>
        <h2 style={{ margin: 0, marginBottom: 12, fontSize: 15, fontWeight: 600 }}>{t('members:changeProductLine')}</h2>
        {error && (
          <div style={{ background: 'var(--destructive-soft)', color: 'var(--destructive)', borderRadius: 6, padding: '8px 12px', fontSize: 12, marginBottom: 10 }}>{error}</div>
        )}
        <div style={{ fontSize: 12, color: 'var(--muted-foreground)', marginBottom: 10 }}>{t('members:changeTo', { name: projectName })}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '12px 0', textAlign: 'center', fontSize: 12, color: 'var(--muted-foreground)' }}>
              {t('members:noLineTargets')}
            </div>
          ) : (
            <select value={targetId} onChange={(e) => setTargetId(e.target.value)} className="input-base">
              <option value="">{t('members:selectTargetLine')}</option>
              {filtered.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          )}
          <div style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>{t('members:lineMoveHint')}</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
            <button onClick={onClose} disabled={saving} style={{ padding: '6px 14px', background: 'var(--popover)', border: '1px solid var(--border)', color: 'var(--muted-foreground)', borderRadius: 6, cursor: 'pointer' }}>{t('common:cancel')}</button>
            <button onClick={() => void handleSubmit()} disabled={saving || !target} style={{
              padding: '6px 14px', border: 'none', background: 'var(--primary)', color: 'var(--primary-foreground)', borderRadius: 6,
              cursor: saving || !target ? 'default' : 'pointer', opacity: saving || !target ? 0.6 : 1,
            }}>{saving ? t('members:changing') : t('members:changeToNamed', { name: target?.name ?? '' })}</button>
          </div>
        </div>
      </div>
    </div>
  );
}