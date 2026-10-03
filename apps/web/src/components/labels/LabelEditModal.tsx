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
        <div className="flex flex-col gap-4 px-5 py-4">
          <div className="flex flex-col gap-1.5">
            <label
              className="text-[11px] font-semibold uppercase tracking-[0.06em]"
              style={{ color: 'var(--color-foreground-muted)' }}
            >
              名称
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：冒烟、回归"
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-2">
            <label
              className="text-[11px] font-semibold uppercase tracking-[0.06em]"
              style={{ color: 'var(--color-foreground-muted)' }}
            >
              颜色
            </label>
            <div className="flex flex-wrap gap-1.5" data-stagger>
              {PRESET_COLORS.map((c) => {
                const selected = color.toLowerCase() === c.toLowerCase();
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    title={c}
                    data-stagger-item
                    className="press"
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 8,
                      background: c,
                      border: 'none',
                      cursor: 'pointer',
                      boxShadow: selected
                        ? `0 0 0 2px var(--color-surface-overlay), 0 0 0 4px ${c}, 0 4px 12px ${c}55`
                        : '0 1px 2px rgba(0,0,0,0.10)',
                      transform: selected ? 'scale(1.06)' : undefined,
                      transition: 'transform 0.18s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.22s ease',
                    }}
                  />
                );
              })}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="shrink-0 press"
                style={{
                  width: 44,
                  height: 32,
                  padding: 0,
                  border: '1px solid var(--color-border)',
                  borderRadius: 8,
                  background: 'var(--color-surface-overlay)',
                  cursor: 'pointer',
                }}
                aria-label="自定义颜色"
              />
              <Input
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="flex-1"
                style={{ fontFamily: 'var(--font-mono, monospace)' }}
              />
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => setColor(PRESET_COLORS[Math.floor(Math.random() * PRESET_COLORS.length)]!)}
              >
                随机
              </Button>
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span
                className="inline-block px-2.5 py-0.5 rounded-full text-[11px] font-medium transition-colors duration-150"
                style={{ background: color, color: labelTextColor(color) }}
              >
                {name.trim() || '标签预览'}
              </span>
              <span className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
                预览
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              className="text-[11px] font-semibold uppercase tracking-[0.06em]"
              style={{ color: 'var(--color-foreground-muted)' }}
            >
              描述（可选）
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="input-base"
              placeholder="如：上线前必跑、阻塞性回归等"
            />
          </div>
        </div>
        <div
          className="flex justify-end gap-2 px-5 py-4 hairline-top"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button disabled={!name.trim() || saving} onClick={handleSave}>
            {saving ? '保存中...' : '保存'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
