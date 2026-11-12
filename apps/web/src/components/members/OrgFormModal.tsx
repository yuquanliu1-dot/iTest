import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';

interface Props {
  visible: boolean;
  org: { id: string; name: string; description?: string | null; parentId: string | null } | null;
  parentId: string | null;
  allOrgs: Array<{ id: string; name: string; path: string }>;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Organization create/edit dialog.
 * - Create: name is required; parentId comes from props; non-platform admins only see the active org and its descendants as selectable parents.
 * - Edit: name/description editable; parentId read-only (avoids accidentally moving a subtree into a cycle).
 */
export default function OrgFormModal({ visible, org, parentId, allOrgs, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ name: '', description: '' });
  const [editParentId, setEditParentId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const isEdit = org !== null;
  // allOrgs is constructed inline by the caller, a new reference on every render; putting it in the effect deps would re-run on every keystroke and clear the form.
  const allOrgsRef = useRef(allOrgs);
  allOrgsRef.current = allOrgs;

  useEffect(() => {
    if (!visible) return;
    if (org) {
      setForm({ name: org.name, description: org.description ?? '' });
      setEditParentId(org.parentId ?? '');
    } else {
      setForm({ name: '', description: '' });
      // Create mode requires a parent org (the API requires parentId to be a uuid): fall back to the topmost visible org when unspecified.
      // Without the fallback, editParentId='' makes the controlled select show the first item as selected while state stays '',
      // and submitting the empty string gets rejected as 400 by z.string().uuid().
      setEditParentId(parentId ?? allOrgsRef.current[0]?.id ?? '');
    }
    setError(null);
    const id = requestAnimationFrame(() => nameRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [visible, org, parentId]);

  if (!visible) return null;

  const handleSubmit = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      if (isEdit && org) {
        await api.orgs.update(org.id, {
          name: form.name.trim(),
          description: form.description.trim() || undefined,
        });
      } else {
        if (!editParentId) {
          setError(t('members:needParentOrg'));
          setSaving(false);
          return;
        }
        await api.orgs.createSubOrg(form.name.trim(), editParentId);
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
          {isEdit ? t('members:editOrg') : t('members:newOrg')}
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
          placeholder={t('members:orgNamePlaceholder')}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleSubmit(); }}
          className="input-base"
        />

        {isEdit ? (
          <>
            <input
              type="text"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder={t('members:orgDescPlaceholder')}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleSubmit(); }}
              className="input-base"
            />
            <div style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>
              {t('members:parentOrgLine', { name: allOrgs.find((o) => o.id === editParentId)?.name ?? t('members:noParent') })}
            </div>
          </>
        ) : (
          <select
            value={editParentId}
            onChange={(e) => setEditParentId(e.target.value)}
            className="input-base"
          >
            {allOrgs.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        )}

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
