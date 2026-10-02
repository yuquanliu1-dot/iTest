import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/Modal';
import Input from '../ui/Input';
import Button from '../ui/Button';
import { labelTextColor } from '../../lib/labelColor';

const PRESET_COLORS = [
  '#34c759', '#007aff', '#ff9500', '#ff3b30', '#af52de', '#5856d6', '#ffcc00',
  '#64d2ff', '#e0aaff', '#fdffb6', '#caffbf', '#ffadad', '#ffd6a5', '#9bf6ff',
];

interface LabelEditModalProps {
  open: boolean;
  label: { name: string; color: string; description: string | null } | null;
  onClose: () => void;
  onSave: (input: { name: string; color: string; description: string | null }) => Promise<void>;
}

export default function LabelEditModal({ open, label, onClose, onSave }: LabelEditModalProps) {
  const [name, setName] = useState('');
  const [color, setColor] = useState('#34c759');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (label) {
      setName(label.name);
      setColor(`#${label.color}`);
      setDescription(label.description ?? '');
    } else {
      setName('');
      setColor('#34c759');
      setDescription('');
    }
  }, [open, label]);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onSave({ name: name.trim(), color, description: description.trim() || null });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label ? '编辑标签' : '新建标签'}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium" style={{ color: 'var(--color-foreground-secondary)' }}>名称</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：冒烟、回归" />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium" style={{ color: 'var(--color-foreground-secondary)' }}>颜色</label>
            <div className="flex flex-wrap gap-1.5">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  title={c}
                  className="w-7 h-7 rounded-[6px] transition-transform hover:scale-110 focus:outline-none"
                  style={{
                    backgroundColor: c,
                    boxShadow: color.toLowerCase() === c.toLowerCase()
                      ? `0 0 0 2px var(--color-surface-overlay), 0 0 0 4px ${c}`
                      : 'none',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                />
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="shrink-0"
                style={{ width: 44, height: 32, padding: 0, border: '1px solid var(--color-border)', borderRadius: 6, background: 'transparent', cursor: 'pointer' }}
                aria-label="自定义颜色"
              />
              <Input
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="flex-1"
                style={{ fontFamily: 'var(--font-mono, monospace)' }}
              />
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => setColor(PRESET_COLORS[Math.floor(Math.random() * PRESET_COLORS.length)]!)}
              >
                随机
              </Button>
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span
                className="inline-block px-2 py-0.5 rounded-[6px] text-[11px] font-medium"
                style={{ background: color, color: labelTextColor(color) }}
              >
                {name.trim() || '标签预览'}
              </span>
              <span className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>预览</span>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium" style={{ color: 'var(--color-foreground-secondary)' }}>描述（可选）</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="input-base"
              placeholder="如：上线前必跑、阻塞性回归等"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
          <Button variant="plain" onClick={onClose}>取消</Button>
          <Button disabled={!name.trim() || saving} onClick={handleSave}>
            {saving ? '保存中...' : '保存'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
