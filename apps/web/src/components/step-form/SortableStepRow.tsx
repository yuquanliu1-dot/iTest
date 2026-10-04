import type { ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import Icon from '../Icon';

interface Props {
  id: string;
  disabled?: boolean;
  isEditing?: boolean;
  children: ReactNode;
}

/** 可排序行容器：仅左侧手柄可发起拖拽（listeners 只绑在手柄上），行内容仍由父级渲染。 */
export default function SortableStepRow({ id, disabled, isEditing, children }: Props) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled });

  return (
    <li
      ref={setNodeRef}
      className="flex items-center gap-3 px-3 py-2 rounded-[var(--radius-sm)]"
      style={{
        background: 'var(--muted)',
        border: `1px solid ${isEditing ? 'var(--primary)' : 'var(--border)'}`,
        transform: CSS.Transform.toString(transform),
        transition,
        ...(isDragging ? { zIndex: 10, opacity: 0.85, boxShadow: '0 4px 16px rgba(0,0,0,0.15)' } : {}),
      }}
    >
      <button
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        disabled={disabled}
        type="button"
        title="拖拽排序"
        aria-label="拖拽排序"
        className="press inline-flex items-center justify-center"
        style={{
          background: 'transparent',
          border: 'none',
          cursor: disabled ? 'default' : 'grab',
          color: 'var(--muted-foreground)',
          padding: 2,
          lineHeight: 1,
          touchAction: 'none',
          borderRadius: 'var(--radius-sm)',
        }}
      >
        <Icon name="gripVertical" size={12} />
      </button>
      {children}
    </li>
  );
}
