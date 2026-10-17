import { useTranslation } from 'react-i18next';
import Icon from '../Icon';

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

/**
 * soft 风格 chip，与 StatusPill 的浅底深字语言一致：
 * 底色 = 标签色低比例混入 var(--card)（color-mix 随主题深浅自动适配），
 * 文字 = 标签色混入少量前景色保证对比度。
 */
export default function TagChip({ tag, onRemove, size = 'sm', className }: TagChipProps) {
  const { t } = useTranslation();
  const padding = size === 'md' ? '3px 10px' : '2px 8px';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-medium ${className ?? ''}`}
      style={{
        background: `color-mix(in srgb, #${tag.color} 14%, var(--card))`,
        color: `color-mix(in srgb, #${tag.color} 75%, var(--foreground))`,
        padding,
        fontSize: 12,
        lineHeight: 1.4,
      }}
    >
      <span className="truncate max-w-[160px]">{tag.name}</span>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label={t('common:removeTag', { name: tag.name })}
          className="inline-flex items-center justify-center"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, color: 'inherit', opacity: 0.7 }}
        >
          <Icon name="close" size={10} />
        </button>
      )}
    </span>
  );
}
