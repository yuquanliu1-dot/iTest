import Icon from '../Icon';
import { labelTextColor } from '../../lib/labelColor';

export interface TagChipData {
  id: string;
  name: string;
  color: string;
}

interface TagChipProps {
  tag: TagChipData;
  onRemove?: () => void;
  size?: 'sm' | 'md';
  className?: string;
}

/** 圆角 chip 渲染：背景 `#${color}`，前景自动选黑/白。点击 X 触发 onRemove。 */
export default function TagChip({ tag, onRemove, size = 'sm', className }: TagChipProps) {
  const bg = `#${tag.color}`;
  const fg = labelTextColor(tag.color);
  const padding = size === 'md' ? '3px 10px' : '2px 8px';
  const fontSize = size === 'md' ? 12 : 11;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-medium ${className ?? ''}`}
      style={{ background: bg, color: fg, padding, fontSize, lineHeight: 1.4 }}
    >
      <span className="truncate max-w-[160px]">{tag.name}</span>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label={`移除标签 ${tag.name}`}
          className="inline-flex items-center justify-center"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, color: fg, opacity: 0.7 }}
        >
          <Icon name="close" size={10} />
        </button>
      )}
    </span>
  );
}
