import { useTranslation } from 'react-i18next';
import LiveViewCard from '../../components/LiveViewCard';
import CollapsiblePanel from '../../components/ui/CollapsiblePanel';
import { useSpaceEventsStore } from './spaceEventsStore';

/** Append replay parameters to the liveUrl delivered by SSE (omitted when speed=1, keeping the URL lean). */
function withSpeed(liveUrl: string, speed: number): string {
  return speed === 1 ? `${liveUrl}?replay=1` : `${liveUrl}?replay=1&speed=${speed}`;
}

/** Recording availability probe URL: liveUrl already carries a random key, so just swapping the query is enough. */
function metaUrl(liveUrl: string): string {
  return `${liveUrl}?replay=meta`;
}

/**
 * Active source of the live view: take this round's liveUrl from the login / verify / solidify progress cards.
 * The three are usually mutually exclusive (only one execution runs at a time on the same thread), but perform_login happens
 * before verify, and the previous round's verify card stays in the store (completed cards must keep their freeze frames/replay),
 * so pick **the latest round by seq** instead of a fixed order — otherwise the login view would be blocked by the previous round's
 * finished liveUrl (reconnecting 404s). A running source outranks a finished one.
 * Shared by the hook and rendering, so SpaceWorkspace can decide whether to render the draggable split.
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

/** Live view rail: renders the live + replay view; returns null when there's no active view. */
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