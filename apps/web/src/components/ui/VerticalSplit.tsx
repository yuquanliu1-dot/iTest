import { useRef, useState, type ReactNode } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

/** 竖直分栏：上半固定像素高(top)，分隔条支持鼠标/触控拖拽调整高度，下半 flex-1。
 *  用 pointer events + setPointerCapture，拖出容器外仍持续跟手；拖拽中禁用文本选中。 */
export default function VerticalSplit({
  top,
  bottom,
  defaultTopPx = 320,
  minTopPx = 120,
  maxTopPx = 600,
}: {
  top: ReactNode;
  bottom: ReactNode;
  defaultTopPx?: number;
  minTopPx?: number;
  maxTopPx?: number;
}) {
  const [topPx, setTopPx] = useState(defaultTopPx);
  const dragRef = useRef<{ startY: number; startPx: number } | null>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = { startY: e.clientY, startPx: topPx };
    // 按住期间禁止选中文本，避免快速拖动时刷出选区
    document.body.style.userSelect = 'none';
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const next = Math.min(maxTopPx, Math.max(minTopPx, d.startPx + (e.clientY - d.startY)));
    setTopPx(next);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    document.body.style.userSelect = '';
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div
        className="shrink-0 min-h-0"
        style={{ height: topPx, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}
      >
        {top}
      </div>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="拖动调整上方高度"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className="shrink-0"
        style={{
          height: 5,
          cursor: 'row-resize',
          touchAction: 'none',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
      </div>
      <div className="flex-1 min-h-0 flex flex-col">{bottom}</div>
    </div>
  );
}