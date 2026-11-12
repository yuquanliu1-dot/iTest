import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import LiveViewImg from './LiveViewImg';
import Button from './ui/Button';
import Segmented from './ui/Segmented';

/** Replay speed presets: 1x original speed; 2/4x skim; 8x to blow through a long recording quickly. */
const SPEEDS = [1, 2, 4, 8] as const;

/** Frame card: live real-time stream + a "replay" button after the run ends (user decision: no autoplay) + replay speed.
 *  While running → live stream (no button); after the run ends → freeze the last frame + "replay" button;
 *  clicking replay → switches to recording replay (?replay=1, plays once from the start then freezes), the button becomes "replay again",
 *  and speed presets appear; switching preset → new URL + key increment, replaying from the start at the new speed.
 *  Opening the already-ended page directly afterwards → no frozen frame, only the "replay" button shows.
 *  key={session} forces <img> remount on every src switch, guaranteeing replay starts from the beginning.
 *
 *  The recording lives only in server memory (30min TTL + LRU 6 entries + lost on process restart), so on end we first probe
 *  ?replay=meta: while probing or when not replayable, the "replay" button is hidden (avoiding a 404 on click). */
export default function LiveViewCard({
  liveUrl,
  replayUrl,
  replayMetaUrl,
  running,
  onFrameHeightChange,
  onFrameVisibleChange,
}: {
  liveUrl: string;
  /** Replay URL with speed (speed=1 is the plain replayUrl). */
  replayUrl: (speed: number) => string;
  /** Recording availability probe URL (?replay=meta). */
  replayMetaUrl: string;
  running: boolean;
  /** Adaptive height reporting: passed through to LiveViewImg (used by the detail page's side-by-side layout); other usages omit it to keep old behavior. */
  onFrameHeightChange?: (h: number) => void;
  onFrameVisibleChange?: (visible: boolean) => void;
}) {
  const { t } = useTranslation();
  const [replaying, setReplaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [session, setSession] = useState(0);
  // The stream mounted at least once during live; only then is the "frozen frame" kept after the run ends. Never-live (browsing afterwards) shows no frozen frame.
  const [everRan, setEverRan] = useState(running);
  if (running && !everRan) setEverRan(true);
  // undefined = not probed (running / probe hasn't returned); true/false = whether the server-side recording can still be replayed.
  const [replayable, setReplayable] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    if (running) {
      setReplayable(undefined);
      return;
    }
    let cancelled = false;
    fetch(replayMetaUrl, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { available: false }))
      .then((m: { available?: boolean }) => {
        if (!cancelled) setReplayable(!!m?.available);
      })
      .catch(() => {
        if (!cancelled) setReplayable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [replayMetaUrl, running]);

  const showImg = running || everRan || replaying;
  const src = running ? liveUrl : replaying ? replayUrl(speed) : liveUrl;
  const mode = running ? 'live' : replaying ? 'replay' : 'frozen';

  const restart = (s: number) => {
    setSpeed(s);
    setReplaying(true);
    setSession((k) => k + 1);
  };

  return (
    <div className="mb-1.5">
      {showImg && (
        <LiveViewImg
          key={session}
          url={src}
          mode={mode}
          retry={running}
          onFrameHeightChange={onFrameHeightChange}
          onFrameVisibleChange={onFrameVisibleChange}
        />
      )}
      {!running && replayable && (
        <div className="flex items-center justify-end gap-1.5">
          {replaying && (
            <Segmented
              value={String(speed)}
              onChange={(v) => restart(Number(v))}
              options={SPEEDS.map((s) => ({ value: String(s), label: `${s}x` }))}
            />
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => restart(speed)}
          >
            {replaying ? t('cases:replayAgain') : t('cases:replay')}
          </Button>
        </div>
      )}
    </div>
  );
}