import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PointerEvent as ReactPointerEvent } from 'react';
import Icon from './Icon';
import { Dialog, DialogContent } from './ui/Modal';

/** 画面形态：live=实时流、replay=录制回放、frozen=已结束定格。仅角标文案/色点不同。 */
export type LiveViewMode = 'live' | 'replay' | 'frozen';

const BADGE: Record<LiveViewMode, { text: string; dot: string }> = {
  live: { text: 'cases:live', dot: 'var(--destructive)' },
  replay: { text: 'cases:replay', dot: 'var(--info)' },
  frozen: { text: 'cases:ended', dot: 'var(--muted-foreground)' },
};

/** 画面高度上下限（px）。默认 220 与改版前一致；拖拽把手在下方。 */
const DEFAULT_H = 220;
const MIN_H = 120;
const MAX_H = 640;

/** 把 <img> 当前那一帧搬进 canvas → dataURL（放大兜底用）。
 *  画面流与页面同域 → canvas 不被污染，可导出；失败（未解码/跨源/无 canvas）返回 null。 */
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

/** 浏览器实时画面（playground）：MJPEG multipart 流，<img> 原生解码逐帧渲染。
 *  流随执行结束由服务端收尾——浏览器保留最后帧（定格），新一轮/新执行开始时一并消失。
 *  replay 模式为录制回放（?replay=1），播完同定格。onError（流异常断开等）隐藏画面，周围进度文字不受影响。
 *  retry=true（运行中）时断流不永久隐藏：2s 后重挂 <img> 重连（跨副本排队延迟期的 404 只是暂时）。
 *  点画面（或右上角放大按钮）弹窗全屏查看：弹窗复用缩略图【同一路资源】（同一个 src，含重试后缀 ?r=N）——
 *  另开一个 <img src=url> 会发新请求，源已结束（执行收尾）时该请求必 404 → 裂图（prod228 实测）；
 *  同一 URL 由浏览器内存缓存/在途响应复用（MJPEG 在途响应也复用），弹窗里看到的就是缩略图那一帧。
 *  万一没命中缓存且源已死 → 退回调色板快照（缩略图当前帧），仍不裂图；快照也没有才提示不可用。 */
export default function LiveViewImg({
  url,
  mode = 'live',
  retry = false,
  frameHeight,
  onFrameHeightChange,
  onFrameVisibleChange,
}: {
  url: string;
  mode?: LiveViewMode;
  retry?: boolean;
  /** 受控画面高度（详情页并排布局用）：传入后高度恒定、宽度按画面比例自适应；
   *  不传保持旧行为（w-full 占满列宽、maxHeight 封顶）。拖拽把手把新高度经回调交还页面。 */
  frameHeight?: number;
  onFrameHeightChange?: (h: number) => void;
  /** 画面窗口在不在（挂载即 true、流断撤框即 false）——并排布局据此决定是否并排。 */
  onFrameVisibleChange?: (visible: boolean) => void;
}) {
  const { t } = useTranslation();
  const [broken, setBroken] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // 放大弹窗兜底：加载失败时先退回调色板快照（缩略图当前帧），再退提示不可用。
  const [zoomShot, setZoomShot] = useState<string | null>(null);
  const [zoomFailed, setZoomFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  // 画面高度可拖拽调整：默认 220（同改版前 maxHeight），把手在画面下方。
  // frameHeight 受控时以此为准，内部状态仅作非受控回退。
  const [innerHeight, setInnerHeight] = useState(DEFAULT_H);
  const height = frameHeight ?? innerHeight;
  const applyHeight = (h: number) => {
    setInnerHeight(h);
    onFrameHeightChange?.(h);
  };
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  useEffect(() => {
    if (!broken || !retry) return;
    const timer = setTimeout(() => {
      setAttempt((a) => a + 1);
      setBroken(false);
    }, 2000);
    return () => clearTimeout(timer);
  }, [broken, retry]);
  // 画面窗口可见性上报：挂载/换源即有框，断流撤框报 false；卸载（含切会话撤框）cleanup 报 false——
  // 真相由本组件负责到底，页面不需要在切会话时自行归零（父级 effect 晚于子级跑，归零会吃掉上报）。
  useEffect(() => {
    onFrameVisibleChange?.(!broken);
    return () => onFrameVisibleChange?.(false);
  }, [broken, url, onFrameVisibleChange]);
  if (broken) return null;
  // 重试后重挂 <img>：URL 加 r= 参数绕开缓存，保证真的重新发起流请求
  const src = attempt === 0 ? url : `${url}${url.includes('?') ? '&' : '?'}r=${attempt}`;

  /** 打开放大弹窗：重置兜底态，弹窗内用与缩略图同一路资源（src）。 */
  const openZoom = () => {
    setZoomShot(null);
    setZoomFailed(false);
    setZoomed(true);
  };

  /** 放大画面加载失败（没命中缓存且源已死）→ 先退快照，再退提示，绝不裂图。 */
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
          alt={t(BADGE[mode].text)}
          className={frameHeight != null ? 'block object-contain' : 'block w-full object-contain'}
          style={frameHeight != null ? { height, width: 'auto', maxWidth: '100%' } : { maxHeight: height }}
        />
        <ModeBadge mode={mode} />
        <span
          className="absolute right-1.5 top-1.5 flex items-center rounded-full px-1.5 py-px"
          style={{ background: 'rgba(0,0,0,0.55)', color: '#fff' }}
        >
          <Icon name="maximize" size={11} />
        </span>
      </div>

      {/* 拖拽把手：调画面高度。放在画面外下方，避免与点画面放大冲突。
          命中区 14px（细线只有 1px，用户看不见也点不中），中间一段短横做可视抓手。 */}
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