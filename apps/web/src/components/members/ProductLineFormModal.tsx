import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type ProductLine } from '../../api/client';

interface Props {
  visible: boolean;
  /** null = 新建。 */
  line: ProductLine | null;
  /** 新建时的归属组织；编辑时忽略——换组织走线详情页的「移动组织」，是另一个动作（会带着整条线搬家）。 */
  organizationId: string;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * 产品线的创建/编辑弹窗（成员管理界面用）。
 * 产品线必属组织，但**这里只管名称与描述**——换组织走产品线详情页的「移动组织」，
 * 那是会带着线内全部项目一起搬家的动作，不能和改名混在一个表单里。
 */
export default function ProductLineFormModal({ visible, line, organizationId, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ name: '', description: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const isEdit = line !== null;

  useEffect(() => {
    if (!visible) return;
    setForm({ name: line?.name ?? '', description: line?.description ?? '' });
    setError(null);
    const id = requestAnimationFrame(() => nameRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [visible, line]);

  if (!visible) return null;

  const handleSubmit = async () => {
    const name = form.name.trim();
    if (!name) return;
    setSaving(true);
    setError(null);
    try {
      if (isEdit && line) {
        await api.productLines.patch(line.id, { name, description: form.description.trim() || undefined });
      } else {
        await api.productLines.create({ name, description: form.description.trim() || undefined, organizationId });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('members:opFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1100,
        background: 'rgba(0,0,0,0.3)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--popover)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-2xl)',
          width: 420, maxWidth: 'calc(100vw - 32px)', padding: 16,
          display: 'flex', flexDirection: 'column', gap: 10,
          maxHeight: '85vh', overflowY: 'auto',
        }}
      >
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--foreground)' }}>
          {isEdit ? t('members:editProductLine') : t('members:newProductLine')}
        </h2>

        {error && (
          <div style={{ background: 'var(--destructive-soft)', color: 'var(--destructive)', borderRadius: 6, padding: '8px 12px', fontSize: 12 }}>
            {error}
          </div>
        )}

        <input
          ref={nameRef}
          type="text"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder={t('members:lineNamePlaceholder')}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleSubmit(); }}
          className="input-base"
        />

        <input
          type="text"
          value={form.description}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          placeholder={t('members:lineDescPlaceholder')}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleSubmit(); }}
          className="input-base"
        />

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button
            onClick={onClose}
            disabled={saving}
            style={{ fontSize: 13, padding: '6px 14px', color: 'var(--muted-foreground)', background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer' }}
          >
            {t('common:cancel')}
          </button>
          <button
            onClick={() => void handleSubmit()}
            disabled={saving || !form.name.trim()}
            style={{
              fontSize: 13, padding: '6px 14px', color: 'var(--primary-foreground)',
              background: 'var(--primary)', border: 'none', borderRadius: 6,
              cursor: saving || !form.name.trim() ? 'default' : 'pointer',
              opacity: saving || !form.name.trim() ? 0.6 : 1,
            }}
          >
            {isEdit ? t('common:save') : t('members:create')}
          </button>
        </div>
      </div>
    </div>
  );
}
