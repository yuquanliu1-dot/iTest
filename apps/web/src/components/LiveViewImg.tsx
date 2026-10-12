import { useState } from 'react';
import Icon from './Icon';
import { Dialog, DialogContent } from './ui/Modal';

/** 画面形态：live=实时流、replay=录制回放、frozen=已结束定格。仅角标文案/色点不同。 */
export type LiveViewMode = 'live' | 'replay' | 'frozen';

const BADGE: Record<LiveViewMode, { text: string; dot: string }> = {
  live: { text: '实时', dot: 'var(--destructive)' },
  replay: { text: '回放', dot: 'var(--info)' },
  frozen: { text: '已结束', dot: 'var(--muted-foreground)' },
};

function ModeBadge({ mode }: { mode: LiveViewMode }) {
  const badge = BADGE[mode];
  return (
    <span
      className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-full px-1.5 py-px text-[10px]"
      style={{ background: 'rgba(0,0,0,0.55)', color: '#fff' }}
    >
      <span className="inline-block size-1.5 rounded-full" style={{ background: badge.dot }} />
      {badge.text}
    </span>
  );
}

/** 浏览器实时画面（playground）：MJPEG multipart 流，<img> 原生解码逐帧渲染。
 *  流随执行结束由服务端收尾——浏览器保留最后帧（定格），新一轮/新执行开始时一并消失。
 *  replay 模式为录制回放（?replay=1），播完同定格。onError（流异常断开等）隐藏画面，周围进度文字不受影响。
 *  点画面（或右上角放大按钮）弹窗全屏查看：弹窗内另开一路同源流——实时模式是多订阅 hub，
 *  回放模式则从录制头部重新播一遍。 */
export default function LiveViewImg({ url, mode = 'live' }: { url: string; mode?: LiveViewMode }) {
  const [broken, setBroken] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  if (broken) return null;
  return (
    <>
      <div
        className="relative mb-1.5 cursor-zoom-in overflow-hidden rounded-[var(--radius-sm)]"
        style={{ border: '1px solid var(--border)', background: 'var(--popover)' }}
        onClick={() => setZoomed(true)}
        role="button"
        tabIndex={0}
        aria-label="放大画面"
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setZoomed(true); } }}
      >
        <img
          src={url}
          onError={() => setBroken(true)}
          alt={BADGE[mode].text}
          className="block w-full object-contain"
          style={{ maxHeight: 220 }}
        />
        <ModeBadge mode={mode} />
        <span
          className="absolute right-1.5 top-1.5 flex items-center rounded-full px-1.5 py-px"
          style={{ background: 'rgba(0,0,0,0.55)', color: '#fff' }}
        >
          <Icon name="maximize" size={11} />
        </span>
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
              alt={BADGE[mode].text}
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