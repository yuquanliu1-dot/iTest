import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { PointerEvent as ReactPointerEvent } from 'react';

/** Vertical split: the top half has a fixed pixel height (top), the separator supports mouse/touch dragging to adjust height, the bottom half is flex-1.
 *  Uses pointer events + setPointerCapture so dragging continues to track even outside the container; text selection disabled while dragging.
 *  Height floor: the bottom slot's minHeight is MIN_BOTTOM_PX — when the container isn't tall enough the top half shrinks to yield,
 *  guaranteeing the bottom half's fixed skeleton (panel title + Tabs + "save selection" action bar) isn't clipped by overflow-hidden. */
const MIN_BOTTOM_PX = 180;

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
  const { t } = useTranslation();
  const [topPx, setTopPx] = useState(defaultTopPx);
  const dragRef = useRef<{ startY: number; startPx: number } | null>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = { startY: e.clientY, startPx: topPx };
    // Disable text selection while held to avoid a selection flashing during fast drags
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
        className="min-h-0"
        style={{ height: topPx, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}
      >
        {top}
      </div>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('common:dragToResize')}
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
      {/* minHeight floor: when dragging stretches the top to full height or the window is too short, the bottom shrinks to the floor value and the extra squeeze
          is absorbed by the top half (no shrink-0) — the shrink-0 skeleton (title/Tabs/action bar) is never clipped. */}
      <div className="flex-1 flex flex-col" style={{ minHeight: MIN_BOTTOM_PX }}>{bottom}</div>
    </div>
  );
}