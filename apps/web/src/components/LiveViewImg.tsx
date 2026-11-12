import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PointerEvent as ReactPointerEvent } from 'react';
import Icon from './Icon';
import { Dialog, DialogContent } from './ui/Modal';

/** Frame form: live = real-time stream, replay = recording replay, frozen = ended and frozen. Only the badge text/dot color differ. */
export type LiveViewMode = 'live' | 'replay' | 'frozen';

const BADGE: Record<LiveViewMode, { text: string; dot: string }> = {
  live: { text: 'cases:live', dot: 'var(--destructive)' },
  replay: { text: 'cases:replay', dot: 'var(--info)' },
  frozen: { text: 'cases:ended', dot: 'var(--muted-foreground)' },
};

/** Frame height bounds (px). The default 220 matches the pre-redesign value; the drag handle sits below. */
const DEFAULT_H = 220;
const MIN_H = 120;
const MAX_H = 640;

/** Copy the <img>'s current frame into a canvas → dataURL (used as the zoom fallback).
 *  The stream is same-origin with the page → the canvas isn't tainted and can be exported; returns null on failure (undecoded/cross-origin/no canvas). */
function snapshotOf(img: HTMLImageElement | null): string | null {
  if (!img || !img.naturalWidth || !img.naturalHeight) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL('image/jpeg', 0.9);
  } catch {
    return null;
  }
}

function ModeBadge({ mode }: { mode: LiveViewMode }) {
  const { t } = useTranslation();
  const badge = BADGE[mode];
  return (
    <span
      className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-full px-1.5 py-px text-[10px]"
      style={{ background: 'rgba(0,0,0,0.55)', color: '#fff' }}
    >
      <span className="inline-block size-1.5 rounded-full" style={{ background: badge.dot }} />
      {t(badge.text)}
    </span>
  );
}

/** Browser live view (playground): MJPEG multipart stream rendered frame by frame via native <img> decoding.
 *  The server winds the stream down when the execution ends — the browser keeps the last frame (frozen), which disappears together when a new round/execution starts.
 *  replay mode is recording replay (?replay=1), frozen the same way when finished. onError (stream broken etc.) hides the frame; surrounding progress text is unaffected.
 *  With retry=true (while running), a broken stream isn't hidden permanently: <img> is remounted after 2s to reconnect (the 404 during cross-replica queuing is only temporary).
 *  Clicking the frame (or the zoom button at top right) opens a fullscreen dialog: the dialog reuses the thumbnail's [same resource] (same src, including the retry suffix ?r=N) —
 *  a separate <img src=url> issues a new request, and once the source has ended (execution wrapped up) that request 404s → broken image (observed on prod228);
 *  the same URL is reused from browser memory cache/in-flight response (MJPEG in-flight responses are reused too), so the dialog shows exactly the thumbnail's frame.
 *  If the cache misses and the source is dead → fall back to the palette snapshot (the thumbnail's current frame), still no broken image; only when there's no snapshot either do we show "unavailable". */
export default function LiveViewImg({
  url,
  mode = 'live',
  retry = false,
  onFrameHeightChange,
  onFrameVisibleChange,
}: {
  url: string;
  mode?: LiveViewMode;
  retry?: boolean;
  /** Adaptive mode (used by the detail page's side-by-side layout): passing onFrameHeightChange enables it —
   *  the frame stretches proportionally to its column width (w-full + height:auto), zero padding and zero cropping inside the box;
   *  the actually rendered height is handed back to the page via callback (on img load + ResizeObserver as a fallback for geometry changes;
   *  side-by-side grid column-width changes don't trigger window resize, so RO is required).
   *  Omitting it keeps old behavior (w-full filling the column, maxHeight cap + drag handle). */
  onFrameHeightChange?: (h: number) => void;
  /** Whether the frame window exists (true on mount, false when the stream breaks and the frame is removed) — the side-by-side layout decides based on this. */
  onFrameVisibleChange?: (visible: boolean) => void;
}) {
  const { t } = useTranslation();
  const [broken, setBroken] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Zoom dialog fallback: on load failure first fall back to the palette snapshot (the thumbnail's current frame), then to the "unavailable" hint.
  const [zoomShot, setZoomShot] = useState<string | null>(null);
  const [zoomFailed, setZoomFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  // Adaptive = the page needs the frame's true height to align with the session-process card; fixed-height mode (default 220, draggable) is for other usages.
  const adaptive = onFrameHeightChange != null;
  const [innerHeight, setInnerHeight] = useState(DEFAULT_H);
  const height = innerHeight;
  const applyHeight = (h: number) => {
    setInnerHeight(h);
    onFrameHeightChange?.(h);
  };
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  // Height reporting: take the img's rendered height (under width:100% + height:auto that's column width / frame aspect ratio).
  // onLoad covers first load and stream reconnect (load fires again after key=attempt remount); RO covers subsequent geometry changes.
  useEffect(() => {
    if (!adaptive || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const h = imgRef.current?.clientHeight ?? 0;
      if (h > 0) onFrameHeightChange?.(h);
    });
    if (imgRef.current) ro.observe(imgRef.current);
    return () => ro.disconnect();
  }, [adaptive, attempt, onFrameHeightChange]);
  const reportFrameHeight = () => {
    const h = imgRef.current?.clientHeight ?? 0;
    if (h > 0) onFrameHeightChange?.(h);
  };
  useEffect(() => {
    if (!broken || !retry) return;
    const timer = setTimeout(() => {
      setAttempt((a) => a + 1);
      setBroken(false);
    }, 2000);
    return () => clearTimeout(timer);
  }, [broken, retry]);
  // Frame-window visibility reporting: mounted/source switched → frame exists; stream broke, frame removed → false; unmount (including frame removal on session switch) cleanup → false —
  // this component owns the truth end to end, so the page doesn't need to zero it itself on session switch (the parent effect runs later than the child's and would swallow the report).
  useEffect(() => {
    onFrameVisibleChange?.(!broken);
    return () => onFrameVisibleChange?.(false);
  }, [broken, url, onFrameVisibleChange]);
  if (broken) return null;
  // Remount <img> after retry: append r= to the URL to bypass the cache, guaranteeing the stream request is genuinely re-issued
  const src = attempt === 0 ? url : `${url}${url.includes('?') ? '&' : '?'}r=${attempt}`;

  /** Open the zoom dialog: reset fallback state; the dialog uses the same resource (src) as the thumbnail. */
  const openZoom = () => {
    setZoomShot(null);
    setZoomFailed(false);
    setZoomed(true);
  };

  /** Zoomed frame load failure (cache missed and source dead) → fall back to the snapshot first, then to the hint; never a broken image. */
  const onZoomError = () => {
    const shot = snapshotOf(imgRef.current);
    if (shot) {
      setZoomShot(shot);
      return;
    }
    setZoomFailed(true);
  };

  const onHandleDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = { startY: e.clientY, startH: height };
    document.body.style.userSelect = 'none';
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHandleMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    applyHeight(Math.min(MAX_H, Math.max(MIN_H, d.startH + (e.clientY - d.startY))));
  };
  const onHandleUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    document.body.style.userSelect = '';
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  return (
    <>
      <div
        className="relative cursor-zoom-in overflow-hidden rounded-[var(--radius-sm)]"
        style={{ border: '1px solid var(--border)', background: 'var(--popover)' }}
        onClick={openZoom}
        role="button"
        tabIndex={0}
        aria-label={t('cases:zoomStage')}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openZoom(); } }}
      >
        <img
          key={attempt}
          ref={imgRef}
          src={src}
          onError={() => setBroken(true)}
          onLoad={reportFrameHeight}
          alt={t(BADGE[mode].text)}
          className={adaptive ? 'block w-full' : 'block w-full object-contain'}
          style={adaptive ? { width: '100%' } : { maxHeight: height }}
        />
        <ModeBadge mode={mode} />
        <span
          className="absolute right-1.5 top-1.5 flex items-center rounded-full px-1.5 py-px"
          style={{ background: 'rgba(0,0,0,0.55)', color: '#fff' }}
        >
          <Icon name="maximize" size={11} />
        </span>
      </div>

      {/* Drag handle: adjusts frame height. Placed below the frame to avoid conflicting with click-to-zoom.
          Hit area 14px (the thin line is only 1px — invisible and unclickable for users), with a short dash in the middle as a visual grip.
          Not rendered in adaptive mode — height is decided by the frame aspect ratio; manual resizing would invite the padding back. */}
      {!adaptive && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t('common:dragToResizeImage')}
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          className="flex shrink-0 cursor-row-resize items-center justify-center"
          style={{ height: 14, touchAction: 'none', marginTop: 2 }}
        >
          <div
            style={{
              width: 36,
              height: 3,
              borderRadius: 2,
              background: 'var(--border)',
            }}
          />
        </div>
      )}

      <Dialog open={zoomed} onOpenChange={(o) => !o && setZoomed(false)}>
        <DialogContent
          style={{
            maxWidth: 'calc(100vw - 48px)',
            width: 'auto',
            background: 'transparent',
            border: 'none',
            boxShadow: 'none',
            padding: 0,
          }}
        >
          <div className="relative">
            {zoomFailed ? (
              <div
                className="flex items-center justify-center rounded-[6px]"
                style={{ width: 320, height: 180, background: 'var(--muted)', color: 'var(--muted-foreground)', fontSize: 13 }}
              >
                {t('cases:liveViewUnavailable')}
              </div>
            ) : zoomShot ? (
              <img
                src={zoomShot}
                alt={t(BADGE[mode].text)}
                className="block rounded-[6px] object-contain"
                style={{ maxWidth: 'calc(100vw - 48px)', maxHeight: 'calc(100vh - 100px)' }}
              />
            ) : (
              <img
                src={src}
                onError={onZoomError}
                alt={t(BADGE[mode].text)}
                className="block rounded-[6px] object-contain"
                style={{ maxWidth: 'calc(100vw - 48px)', maxHeight: 'calc(100vh - 100px)' }}
              />
            )}
            <ModeBadge mode={mode} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}