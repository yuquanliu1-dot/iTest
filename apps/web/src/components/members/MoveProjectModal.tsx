import { useEffect, useState } from 'react';
import { api, type Project } from '../../api/client';

interface OrgChoice {
  id: string;
  name: string;
}

interface Props {
  visible: boolean;
  projectId: string;
  projectName: string;
  currentOrgId: string;
  choices: OrgChoice[];
  onClose: () => void;
  onMoved: (updated: Project) => void;
}

/**
 * 移动项目到另一组织（manager）。候选列表为调用者 manager 的组织。
 */
export default function MoveProjectModal({ visible, projectId, projectName, currentOrgId, choices, onClose, onMoved }: Props) {
  const [targetId, setTargetId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setTargetId('');
    setError(null);
    setSaving(false);
  }, [visible]);

  const filtered = choices.filter((o) => o.id !== currentOrgId);
  const target = filtered.find((o) => o.id === targetId);

  const handleSubmit = async () => {
    if (!target || saving) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.projects.move(projectId, target.id);
      onMoved(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setSaving(false);
    }
  };

  if (!visible) return null;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16, width: 420, maxWidth: 'calc(100vw - 32px)' }}>
        <h2 style={{ margin: 0, marginBottom: 12, fontSize: 15, fontWeight: 600 }}>移动项目</h2>
        {error && (
          <div style={{ background: 'var(--destructive-soft)', color: 'var(--destructive)', borderRadius: 6, padding: '8px 12px', fontSize: 12, marginBottom: 10 }}>{error}</div>
        )}
        <div style={{ fontSize: 12, color: 'var(--muted-foreground)', marginBottom: 10 }}>将「{projectName}」移动到：</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <select value={targetId} onChange={(e) => setTargetId(e.target.value)} className="input-base">
            <option value="">— 选择目标组织 —</option>
            {filtered.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
            <button onClick={onClose} disabled={saving} style={{ padding: '6px 14px', background: 'var(--popover)', border: '1px solid var(--border)', color: 'var(--muted-foreground)', borderRadius: 6, cursor: 'pointer' }}>取消</button>
            <button onClick={() => void handleSubmit()} disabled={saving || !target} style={{
              padding: '6px 14px', border: 'none', background: 'var(--primary)', color: 'var(--primary-foreground)', borderRadius: 6,
              cursor: saving || !target ? 'default' : 'pointer', opacity: saving || !target ? 0.6 : 1,
            }}>{saving ? '移动中…' : `移动到「${target?.name ?? ''}」`}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
