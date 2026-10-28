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
 * 实时画面的活跃源：从 login / verify / solidify 进度卡里取本轮 liveUrl。
 * 三者通常互斥（同一线程同一时刻只有一种执行在跑），但 perform_login 发生在
 * verify 之前，而上一轮的 verify 卡会留在 store 里（已完成卡要保留下列定格帧/回放），
 * 因此**按 seq 取最新一轮**而不是按固定顺序——否则登录画面会被上一轮已结束的
 * liveUrl（再连即 404）挡掉。运行中的源优先于已结束源。
 * hook 与渲染共用，供 SpaceWorkspace 判断是否渲染可拖拽分栏。
 */
export function useActiveLiveView() {
  const verify = useSpaceEventsStore((s) => s.verifyProgress);
  const solidify = useSpaceEventsStore((s) => s.solidifyProgress);
  const login = useSpaceEventsStore((s) => s.loginProgress);
  const candidates = [verify, solidify, login].filter((p) => p?.liveUrl) as Array<
    { liveUrl: string | null; result: string | null; seq?: number }
  >;
  if (candidates.length === 0) return null;
  const running = candidates.filter((p) => p.result === null);
  const pool = running.length > 0 ? running : candidates;
  return pool.reduce((a, b) => ((b.seq ?? 0) > (a.seq ?? 0) ? b : a));
}

/** 实时画面栏：渲染成 live + 回放画面，无活跃画面时返回 null。 */
export default function LiveViewRail() {
  const { t } = useTranslation();
  const vp = useActiveLiveView();
  if (!vp) return null;
  const running = vp.result === null;
  return (
    <CollapsiblePanel title={t('assistant:liveView.title')} defaultOpen divider={false}>
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