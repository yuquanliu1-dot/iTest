import { useTranslation } from 'react-i18next';
import LiveViewCard from '../../components/LiveViewCard';
import CollapsiblePanel from '../../components/ui/CollapsiblePanel';
import { useSpaceEventsStore } from './spaceEventsStore';

/** SSE 下发的 liveUrl 上拼回放参数（speed=1 时省略，保持 URL 简洁）。 */
function withSpeed(liveUrl: string, speed: number): string {
  return speed === 1 ? `${liveUrl}?replay=1` : `${liveUrl}?replay=1&speed=${speed}`;
}

/** 录制可用性探测 URL：liveUrl 后面已经带了随机 key，直接换 query 即可。 */
function metaUrl(liveUrl: string): string {
  return `${liveUrl}?replay=meta`;
}

/**
 * 实时画面的活跃源：从 verify / solidify 进度卡里取本轮 liveUrl。
 * 两侧互斥（verify 结束后才可能固化），同有值时取 verify 那份。
 * hook 与渲染共用，供 SpaceWorkspace 判断是否渲染可拖拽分栏。
 */
export function useActiveLiveView() {
  const verify = useSpaceEventsStore((s) => s.verifyProgress);
  const solidify = useSpaceEventsStore((s) => s.solidifyProgress);
  return verify?.liveUrl ? verify : solidify?.liveUrl ? solidify : null;
}

/** 实时画面栏：渲染成 live + 回放画面，无活跃画面时返回 null。 */
export default function LiveViewRail() {
  const { t } = useTranslation();
  const vp = useActiveLiveView();
  if (!vp) return null;
  const running = vp.result === null;
  return (
    <CollapsiblePanel title={t('assistant:liveView.title')} defaultOpen>
      <div className="px-4 pb-3">
        <LiveViewCard
          liveUrl={vp.liveUrl!}
          replayUrl={(speed) => withSpeed(vp.liveUrl!, speed)}
          replayMetaUrl={metaUrl(vp.liveUrl!)}
          running={running}
        />
      </div>
    </CollapsiblePanel>
  );
}