import { useEffect, useRef, useState } from 'react';
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
 * 组织的创建/编辑弹窗。
 * - Create：name 必填；parentId 由 props 指定；非平台管理员只看到当前激活组织及后代为可选 parent。
 * - Edit：name/description 可改；parentId 只读（避免误操作把子树搬成环）。
 */
export default function OrgFormModal({ visible, org, parentId, allOrgs, onClose, onSaved }: Props) {
  const [form, setForm] = useState({ name: '', description: '' });
  const [editParentId, setEditParentId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const isEdit = org !== null;

  useEffect(() => {
    if (!visible) return;
    if (org) {
      setForm({ name: org.name, description: org.description ?? '' });
      setEditParentId(org.parentId ?? '');
    } else {
      setForm({ name: '', description: '' });
      setEditParentId(parentId ?? '');
    }
    setError(null);
    const id = requestAnimationFrame(() => nameRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [visible, org, parentId]);

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
        await api.orgs.createSubOrg(form.name.trim(), editParentId);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
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
          background: 'var(--color-surface-overlay)', border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-modal)',
          width: 420, maxWidth: 'calc(100vw - 32px)', padding: 16,
          display: 'flex', flexDirection: 'column', gap: 10,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--color-foreground)' }}>
          {isEdit ? '编辑组织' : '新建组织'}
        </h2>

        {error && (
          <div style={{ background: 'var(--color-destructive-light)', color: 'var(--color-destructive)', borderRadius: 6, padding: '8px 12px', fontSize: 12 }}>
            {error}
          </div>
        )}

        <input
          ref={nameRef}
          type="text"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="组织名称"
          onKeyDown={(e) => { if (e.key === 'Enter') void handleSubmit(); }}
          className="input-base"
        />

        {isEdit ? (
          <>
            <input
              type="text"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="组织描述（可选）"
              onKeyDown={(e) => { if (e.key === 'Enter') void handleSubmit(); }}
              className="input-base"
            />
            <div style={{ fontSize: 11, color: 'var(--color-foreground-disabled)' }}>
              上级组织：{allOrgs.find((o) => o.id === editParentId)?.name ?? '（无）'}
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
            style={{ fontSize: 13, padding: '6px 14px', color: 'var(--color-foreground-muted)', background: 'transparent', border: 'none', borderRadius: 6, cursor: 'pointer' }}
          >
            取消
          </button>
          <button
            onClick={() => void handleSubmit()}
            disabled={saving || !form.name.trim()}
            style={{
              fontSize: 13, padding: '6px 14px', color: 'var(--color-accent-foreground)',
              background: 'var(--color-accent)', border: 'none', borderRadius: 6,
              cursor: saving || !form.name.trim() ? 'default' : 'pointer',
              opacity: saving || !form.name.trim() ? 0.6 : 1,
            }}
          >
            {isEdit ? '保存' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}
