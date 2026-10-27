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
 *  点画面（或右上角放大按钮）弹窗全屏查看：弹窗内另开一路同源流——实时模式是多订阅 hub，
 *  回放模式则从录制头部重新播一遍。 */
export default function LiveViewImg({
  url,
  mode = 'live',
  retry = false,
}: {
  url: string;
  mode?: LiveViewMode;
  retry?: boolean;
}) {
  const { t } = useTranslation();
  const [broken, setBroken] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // 画面高度可拖拽调整：默认 220（同改版前 maxHeight），把手在画面下方。
  const [height, setHeight] = useState(DEFAULT_H);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  useEffect(() => {
    if (!broken || !retry) return;
    const timer = setTimeout(() => {
      setAttempt((a) => a + 1);
      setBroken(false);
    }, 2000);
    return () => clearTimeout(timer);
  }, [broken, retry]);
  if (broken) return null;
  // 重试后重挂 <img>：URL 加 r= 参数绕开缓存，保证真的重新发起流请求
  const src = attempt === 0 ? url : `${url}${url.includes('?') ? '&' : '?'}r=${attempt}`;

  const onHandleDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = { startY: e.clientY, startH: height };
    document.body.style.userSelect = 'none';
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHandleMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setHeight(Math.min(MAX_H, Math.max(MIN_H, d.startH + (e.clientY - d.startY))));
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
        onClick={() => setZoomed(true)}
        role="button"
        tabIndex={0}
        aria-label={t('cases:zoomStage')}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setZoomed(true); } }}
      >
        <img
          key={attempt}
          src={src}
          onError={() => setBroken(true)}
          alt={t(BADGE[mode].text)}
          className="block w-full object-contain"
          style={{ maxHeight: height }}
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
            <img
              src={url}
              alt={t(BADGE[mode].text)}
              className="block rounded-[6px] object-contain"
              style={{ maxWidth: 'calc(100vw - 48px)', maxHeight: 'calc(100vh - 100px)' }}
            />
            <ModeBadge mode={mode} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}